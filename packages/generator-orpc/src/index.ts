import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { AffixOptions, ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  importSpecifier,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
} from '@drzl/validation-core';

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
  /**
   * How the router barrel spells the extension of the router files it imports. Defaults to
   * `'js'`, so `users.ts` is imported as `./users.js`, the only form that resolves under
   * every `moduleResolution` without a compiler flag. Use `'none'` for the extensionless
   * specifiers drzl emitted before 2.0.
   *
   * It also governs `validation.importPath`. That used to be emitted verbatim, which meant a
   * project-relative value like `src/validators/zod` became a bare specifier naming a package
   * in node_modules, and the import resolved to nothing. A path already written relative to the
   * output directory keeps its own spelling, and a real package name is left untouched.
   */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string; // barrel path like src/validators/zod
    schemaSuffix?: string; // default 'Schema'
    /**
     * Must describe how the validation generator named its exports, because it is what
     * spells the import specifier this router pulls them out of. The CLI copies it from the
     * sibling validation generator when it is not set here, so the two cannot drift.
     *
     * It does not rename anything the router itself declares: the local aliases stay
     * `Insert<tsName>Schema` so the router body is unaffected either way.
     */
    affix?: AffixOptions;
  };
  databaseInjection?: {
    enabled?: boolean; // Enable database injection mode (default: false for backward compatibility)
    databaseType?: string; // Type annotation for injected database (e.g. 'DrizzleD1Database', 'Database')
    databaseTypeImport?: { name: string; from: string };
  };
  servicesDir?: string; // Path to services directory (e.g. 'src/services')
}

export interface ProcedureSpec {
  name: string; // exported property key (transformed later)
  varName: string; // variable identifier declared in code
  code: string; // procedure implementation
}

/**
 * The scalar for a foreign key column, in whichever validation library is in play.
 *
 * Only the types a key can actually be are listed. Anything else falls back to the library's
 * permissive type rather than guessing, since a foreign key on an exotic column is still a
 * lookup worth exposing.
 */
function scalarExpr(tsType: string, lib: Lib): string {
  const d = LIBS[lib];
  const bare =
    tsType === 'number'
      ? d.number
      : tsType === 'string'
        ? d.string
        : tsType === 'boolean'
          ? d.boolean
          : d.unknown;
  // ArkType types are strings and this expression is emitted inline rather than through
  // `renderSchema`, so it carries its own quotes.
  return d.fieldIsString ? `'${bare}'` : bare;
}

export interface ORPCTemplateHooks {
  filePath(table: Table, ctx: { outDir: string; naming?: NamingOptions }): string;
  routerName(table: Table, ctx: { naming?: NamingOptions }): string;
  procedures(
    table: Table,
    ctx?: { databaseInjection?: { enabled?: boolean; databaseType?: string } }
  ): ProcedureSpec[];
  imports?(
    tables: Table[],
    ctx?: {
      outDir: string;
      naming?: NamingOptions;
      servicesDir?: string;
      databaseInjection?: { enabled?: boolean; databaseType?: string };
    }
  ): string;
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
        // These two throw rather than returning the input. The generator declares
        // `.output(SelectSchema)` on both, and the input is the *insert* shape, where generated
        // and defaulted columns are optional and in select they are required. Returning it did
        // not typecheck, and would not have been correct if it had: a created row carries
        // columns the input never had. A body that only throws has type `never`, so it honours
        // the declared contract and says plainly that the work is not done.
        make(
          'create',
          createVar,
          `const ${createVar} = os.input(z.any()).handler(async ({ input: _input }) => { throw new Error('Not implemented: create ${table.tsName}. Persist the input and return the created row.'); });`
        ),
        make(
          'update',
          updateVar,
          `const ${updateVar} = os.input(z.object({ id: z.number(), data: z.any() })).handler(async ({ input: _input }) => { throw new Error('Not implemented: update ${table.tsName}. Apply the patch and return the updated row.'); });`
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

/**
 * Libraries a router can actually be built from.
 *
 * TypeBox is absent deliberately, and it is the one validator DRZL generates that cannot appear
 * here: oRPC types `.input()`/`.output()` as a Standard Schema, and neither `@sinclair/typebox`
 * nor `typebox` implements that spec, while zod, valibot and arktype all do. A router wired to a
 * TypeBox schema would typecheck against `any` and fail at runtime, so `validation.library` in
 * the config schema rejects it outright instead. The standalone typebox generator is unaffected.
 */
type Lib = 'zod' | 'valibot' | 'arktype';

/**
 * How each validation library spells the handful of constructs a router needs.
 *
 * A table rather than a chain of ternaries. The chain read `lib === 'arktype' ? a : lib === 'zod'
 * ? b : c`, so its final branch was "valibot, or anything else", and adding a fourth library
 * would have silently emitted valibot code for it rather than failing. Everything a library has
 * to answer is now a required field, so a new one cannot be half-added.
 *
 * Enum values go through `JSON.stringify` rather than being interpolated raw: a value containing
 * an apostrophe used to emit unparseable code, which crashed prettier and took the run down.
 */
interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  unknown: string;
  enum: (vals: string[]) => string;
  array: (element: string) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  /** Same, on one line. A single-key lookup input reads better without the wrapping. */
  objectInline: (body: string) => string;
  /**
   * A fixed-length tuple of numbers: a `point`, a `line`, a `geometry`.
   *
   * Absent for ArkType, which is not an oversight. Its field values are emitted as quoted
   * string-DSL fragments, and the DSL has no tuple: `type({ p: '[number, number]' })` throws
   * `Expected an expression before '[number, number]'`, measured. The array-literal form
   * `type({ p: ['number', 'number'] })` does work and does reject a third element, but it is not a
   * string, so it composes with neither `nullable` nor `optional` here, both of which build DSL
   * text around their argument. ArkType therefore keeps `unknown` for these columns.
   */
  tuple?: (length: number) => string;
  /** ArkType types are strings, so the field value is JSON-encoded rather than emitted bare. */
  fieldIsString?: boolean;
  /** Applied to the whole update schema, where the library has a shorthand for it. */
  partialUpdate?: (schema: string) => string;
}

const q = (v: string) => JSON.stringify(v);

/** The import each library's emitted expressions need, keyed the same way as `LIBS`. */
const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod'",
  valibot: "import * as v from 'valibot'",
  arktype: "import { type } from 'arktype'",
};

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    number: 'z.number()',
    string: 'z.string()',
    boolean: 'z.boolean()',
    date: 'z.date()',
    unknown: 'z.unknown()',
    tuple: (n) => `z.tuple([${Array.from({ length: n }, () => 'z.number()').join(', ')}])`,
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    array: (e) => `z.array(${e})`,
    nullable: (b) => `${b}.nullable()`,
    optional: (b) => `${b}.optional()`,
    object: (body) => `z.object({\n${body}\n})`,
    objectInline: (body) => `z.object({ ${body} })`,
    partialUpdate: (s) => `${s}.partial()`,
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    date: 'v.date()',
    unknown: 'v.unknown()',
    tuple: (n) => `v.tuple([${Array.from({ length: n }, () => 'v.number()').join(', ')}])`,
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    array: (e) => `v.array(${e})`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
  },
  arktype: {
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    date: 'Date',
    unknown: 'unknown',
    // The surrounding encode adds the quotes, so the union is built with the inner quoting
    // ArkType expects. Emitting `'${...}'` here produced `''admin' | 'user''`, which does not parse.
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    array: (e) => `${e}.array()`,
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    object: (body) => `type({\n${body}\n})`,
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
  },
};

function mapExpr(column: Column, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  let base = (() => {
    if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
    // Before the analyzer described a `point` as a tuple this landed on `string` on drizzle-orm
    // 0.4x, which refuses the value the driver returns, and then on `unknown`, which accepts
    // anything at all including a null payload the insert will not survive. Neither is the column.
    if (column.shape?.kind === 'tuple' && d.tuple) return d.tuple(column.shape.length);
    switch (column.tsType) {
      case 'number':
        return d.number;
      case 'string':
        return d.string;
      case 'boolean':
        return d.boolean;
      case 'Date':
        return d.date;
      default:
        return d.unknown;
    }
  })();
  if (column.nullable) base = d.nullable(base);
  if (mode !== 'select') {
    const optional = mode === 'update' || column.nullable || column.hasDefault;
    if (optional) base = d.optional(base);
  }
  return base;
}

function renderSchema(table: Table, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  const cols = table.columns.filter((c) => (mode === 'select' ? true : !c.isGenerated));
  // Keys go through JSON.stringify, matching the standalone generators. A column named with
  // anything that is not a bare identifier produced invalid object syntax here.
  const body = cols
    .map((c) => {
      const expr = mapExpr(c, lib, mode);
      return `  ${JSON.stringify(c.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr},`;
    })
    .join('\n');
  const schema = d.object(body);
  return mode === 'update' && d.partialUpdate ? d.partialUpdate(schema) : schema;
}

export class ORPCGenerator {
  constructor(private analysis: Analysis) {}

  /**
   * One lookup per single-column foreign key: `listByAuthorId({ authorId })`.
   *
   * Synthesised here rather than in the template so that enabling `includeRelations` works
   * with every template, including custom ones, which is what setting the flag implies. A
   * template that already declares a procedure of the same name wins, so this can only ever
   * add to the surface.
   *
   * Named after the *column*, not the referenced table. Two keys frequently point at the same
   * table, `authorId` and `editorId` both referencing `users` being the ordinary case, and
   * naming by table would emit one procedure twice under the same key.
   *
   * Restricted to single-column keys. A composite key has no single scalar to accept, and
   * inventing a shape for it would be guessing at an API rather than deriving one. It also
   * only ever returns rows of its own table, whose select schema is already in scope: the
   * inverse direction would return another table's rows and require an import this file has
   * no way to resolve.
   */
  private relationProcedures(
    table: Table,
    lib: Lib,
    selectSchemaName: string,
    taken: Set<string>
  ): ProcedureSpec[] {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const T = cap(table.tsName);
    const specs: ProcedureSpec[] = [];

    for (const fk of table.foreignKeys ?? []) {
      if (fk.columns.length !== 1) continue;
      const colName = fk.columns[0];
      const column = table.columns.find((c) => c.name === colName);
      if (!column) continue;

      const name = `listBy${cap(colName)}`;
      if (taken.has(name)) continue;
      taken.add(name);

      const varName = `${name}${T}`;
      const key = JSON.stringify(colName);
      const input = LIBS[lib].objectInline(`${colName}: ${scalarExpr(column.tsType, lib)}`);
      const output = LIBS[lib].array(selectSchemaName);

      specs.push({
        name,
        varName,
        // The body is a stub, exactly like every other generated procedure here: this package
        // emits the router surface and leaves the query to the service layer.
        code:
          `const ${varName} = os\n` +
          `  .input(${input})\n` +
          `  .output(${output})\n` +
          `  .handler(async ({ input: _input }) => {\n` +
          `    // Rows of ${table.name} whose ${key} matches _input.${colName}.\n` +
          `    return [];\n` +
          `  });`,
      });
    }
    return specs;
  }

  /**
   * Lookups that return rows of a *different* table: the inverse of a foreign key, and the far
   * side of a many-to-many.
   *
   *   users.listPosts   every post whose authorId is this user
   *   posts.listTags    every tag joined to this post through posts_to_tags
   *
   * These need the other table's select schema, which lives in the other table's router file.
   * That import is genuinely circular whenever both directions are emitted, which many-to-many
   * always does, and an eager cross-import fails at runtime with "Cannot access X before
   * initialization" rather than at compile time. So the reference is deferred: `z.lazy` and
   * `v.lazy` both evaluate on first use, by which point both modules are initialised.
   *
   * ArkType is skipped. Its deferred form differs enough that emitting an untested shape here
   * would be guessing, and an endpoint that fails to load is worse than one that is absent.
   */
  private crossTableProcedures(
    table: Table,
    analysis: Analysis,
    lib: Lib,
    affix: ReturnType<typeof resolveAffix>,
    taken: Set<string>,
    imports: Map<string, string>
  ): ProcedureSpec[] {
    if (lib === 'arktype') return [];

    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const T = cap(table.tsName);
    const specs: ProcedureSpec[] = [];
    const byDbName = new Map(analysis.tables.map((t) => [t.name, t]));

    const wanted = (analysis.relations ?? []).filter(
      (r) => r.from === table.name && (r.kind === 'many' || r.kind === 'manyToMany')
    );

    for (const rel of wanted) {
      const target = byDbName.get(rel.to);
      if (!target || target.name === table.name) continue;

      const name = `list${cap(target.tsName)}`;
      if (taken.has(name)) continue;
      taken.add(name);

      const targetSchema = schemaName('select', target.tsName, affix);
      imports.set(target.tsName, targetSchema);

      const lazyRef =
        lib === 'zod' ? `z.lazy(() => ${targetSchema})` : `v.lazy(() => ${targetSchema})`;
      const output = lib === 'zod' ? `z.array(${lazyRef})` : `v.array(${lazyRef})`;
      const idExpr =
        lib === 'zod' ? 'z.object({ id: z.number() })' : 'v.object({ id: v.number() })';

      const via = rel.kind === 'manyToMany' ? ` through ${rel.via}` : '';
      specs.push({
        name,
        varName: `${name}${T}`,
        code:
          `const ${name}${T} = os\n` +
          `  .input(${idExpr})\n` +
          `  .output(${output})\n` +
          `  .handler(async ({ input: _input }) => {\n` +
          `    // Rows of ${target.name} related to this ${table.name}${via}.\n` +
          `    return [];\n` +
          `  });`,
      });
    }
    return specs;
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
        const tmplName: any = '@drzl/template-orpc-service';
        const mod: any = await import(tmplName);
        const hooks = mod?.default ?? mod;
        template = hooks as ORPCTemplateHooks;
      } catch {}
    } else if (opts.template && opts.template !== 'minimal') {
      try {
        const { pathToFileURL } = await import('node:url');
        const url = opts.template.startsWith('file://')
          ? opts.template
          : pathToFileURL(opts.template).href;
        const mod: any = await import(url);
        template = (mod?.default ?? mod) as ORPCTemplateHooks;
        console.log('[orpc] Loaded custom template from', url);
      } catch (_e) {
        // fall back to default
      }
    }

    // Emit one file per table or a placeholder when none.
    if (!this.analysis.tables.length) {
      const p = path.join(out, 'placeholder.orpc.ts');
      const formatted = await formatCode(
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
      const content = this.renderRouter(table, template, out, opts);
      const formatted = await formatCode(
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
        const rel = importSpecifier(
          './' + path.relative(out, filePath).replace(/\\/g, '/'),
          opts.importExtension
        );
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
      const barrelFormatted = await formatCode(
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

  /**
   * Takes the options object rather than a positional list. It had grown to nine parameters,
   * all optional and several of the same type, so adding one meant counting commas at the call
   * site and a transposed pair would have typechecked.
   */
  private renderRouter(
    table: Table,
    template: ORPCTemplateHooks,
    outDir: string,
    opts: GenerateOptions
  ) {
    const {
      naming,
      templateOptions,
      validation,
      databaseInjection,
      servicesDir,
      includeRelations,
      importExtension,
    } = opts;
    // Build shared schemas (library-aware)
    const lib: Lib = (validation?.library ?? 'zod') as Lib;
    const createSchemaName = `Insert${table.tsName}Schema`;
    const updateSchemaName = `Update${table.tsName}Schema`;
    const selectSchemaName = `Select${table.tsName}Schema`;
    const sharedSchemasInline = `export const ${createSchemaName} = ${renderSchema(table, lib, 'insert')}\nexport const ${updateSchemaName} = ${renderSchema(table, lib, 'update')}\nexport const ${selectSchemaName} = ${renderSchema(table, lib, 'select')}`;

    // Template procedures (fallback default uses inline zod; we replace to use shared)
    const templateProcs = template.procedures(table, { databaseInjection: databaseInjection });
    // Select schemas of other tables that cross-table lookups refer to, keyed by tsName, so the
    // import can be emitted once alongside the rest.
    const crossTableImports = new Map<string, string>();
    // Relation lookups are appended, never substituted, so the CRUD surface is identical
    // whether or not the flag is set.
    const hooksProcs = includeRelations
      ? (() => {
          const taken = new Set(templateProcs.map((p) => p.name));
          const own = this.relationProcedures(table, lib, selectSchemaName, taken);
          const cross = this.crossTableProcedures(
            table,
            this.analysis,
            lib,
            resolveAffix({ affix: validation?.affix, schemaSuffix: validation?.schemaSuffix }),
            taken,
            crossTableImports
          );
          return [...templateProcs, ...own, ...cross];
        })()
      : templateProcs;
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
          outExpr = LIBS[lib].array(selectSchemaName);
        } else if (p.name === 'get') {
          outExpr = LIBS[lib].nullable(selectSchemaName);
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
      // A template that imports generated modules has to spell extensions the same way the
      // barrel does. Without this it could not see the setting at all, which is how the service
      // import became the one relative specifier in the output with no `.js`.
      importExtension,
      ...(templateOptions ?? {}),
    } as any;
    const libImport = LIB_IMPORTS[lib];
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
    // The single line that has to agree with generator-zod/valibot/arktype. Both sides now
    // derive the name from the same resolver, so `affix` and `schemaSuffix` cannot be
    // interpreted two different ways.
    const sharedAffix = resolveAffix({
      affix: validation?.affix,
      schemaSuffix: validation?.schemaSuffix,
    });
    const sharedName = (mode: 'insert' | 'update' | 'select') =>
      schemaName(mode, table.tsName, sharedAffix);
    // `importPath` used to be emitted verbatim. A project-relative value such as
    // `src/validators/zod`, which is what the guide showed and how the rest of the config names
    // directories, is a bare specifier to Node and tsc, so the import resolved to nothing.
    const sharedImportSpecifier = useShared
      ? resolveConfiguredImport(validation!.importPath!, outDir, process.cwd(), importExtension)
      : '';
    const importSchemas = useShared
      ? `\nimport { ${sharedName('insert')} as ${createSchemaName}, ${sharedName('update')} as ${updateSchemaName}, ${sharedName('select')} as ${selectSchemaName} } from '${sharedImportSpecifier}';`
      : '';
    // Where the other tables' select schemas come from. With shared validation they all live in
    // one barrel, so a single import covers them. Otherwise each router declares and exports its
    // own, and they are pulled from the sibling router files; those imports are circular by
    // nature, which is why the procedures reference them lazily.
    const crossImports = [...crossTableImports.entries()]
      .filter(([tsName]) => tsName !== table.tsName)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tsName, schema]) =>
        useShared
          ? `\nimport { ${schema} } from '${sharedImportSpecifier}';`
          : `\nimport { ${schema} } from '${importSpecifier(`./${template.filePath({ ...table, tsName } as Table, { outDir: '.', naming }).replace(/^\.\//, '')}`, importExtension)}';`
      )
      .join('');

    const imports = importsBase + importSchemas + crossImports;
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
