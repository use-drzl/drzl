import { importSpecifier, type ImportExtension } from '@drzl/validation-core';

// Minimal local shapes to avoid cross-package DTS complexity. The runtime object the generator
// passes is the full analyzer table, so the key facts this template needs are simply read off
// it; the fields are optional because a hand-built `{ name, tsName }` is still a valid table,
// one that reads as keyless.
interface Column {
  name: string;
  tsType: string;
  nullable?: boolean;
  enumValues?: string[];
}
interface Table {
  name: string;
  tsName: string;
  columns?: Column[];
  primaryKey?: { columns: string[] };
}

/**
 * The columns that address one row, or `null` when nothing does: the same reading of
 * `primaryKey` as `@drzl/generator-service`, whose emitted classes these handler bodies call.
 * This template used to hardcode `Service.getById(input.id)` whatever the key was, which was a
 * number into a varchar key's `id: string`, one argument into a composite key's parameter list,
 * and a method that does not exist on the service of a keyless table.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length || !table.columns) return null;
  const cols = names.map((n) => table.columns!.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * Whether the router's input schema can type this key column, which is exactly when the emitted
 * service call typechecks: number, string, boolean, Date and enum literals have a spelling, and
 * everything else arrives as `z.unknown()`, which the service's typed key parameter does not
 * accept.
 */
function serviceKeyExpressible(c: Column): boolean {
  if (c.enumValues && c.enumValues.length) return true;
  // `bigint` joined the list when the routers stopped calling it `unknown`. It has a wire form,
  // its decimal digits, and the conversion back is exact, so the call below can be written.
  return ['number', 'string', 'boolean', 'Date', 'bigint'].includes(c.tsType);
}

/**
 * One key column as the service wants it, from the input as the wire carries it.
 *
 * Only `bigint` differs from the identity. It crosses as digits, because `JSON.stringify(1n)`
 * throws and a `number` loses precision past 2^53, and the service's parameter is a real `bigint`.
 * The input schema's pattern is what makes `BigInt()` total here: nothing else reaches this line.
 */
function serviceKeyArg(c: Column): string {
  return c.tsType === 'bigint' ? `BigInt(input.${c.name})` : `input.${c.name}`;
}

/** The zod spelling of one key column, for the input this template writes before the generator rewrites it. */
function zodKeyExpr(c: Column): string {
  const base =
    c.enumValues && c.enumValues.length
      ? `z.enum([${c.enumValues.map((v) => JSON.stringify(v)).join(', ')}] as const)`
      : c.tsType === 'number'
        ? 'z.number()'
        : c.tsType === 'string'
          ? 'z.string()'
          : c.tsType === 'boolean'
            ? 'z.boolean()'
            : c.tsType === 'Date'
              ? 'z.date()'
              : // Digits, which is how a bigint crosses JSON at all; see `serviceKeyArg`.
                c.tsType === 'bigint'
                ? String.raw`z.string().regex(/^-?\d+$/)`
                : 'z.unknown()';
  return c.nullable ? `${base}.nullable()` : base;
}

/** Why a procedure is a stub, stated in the emitted file rather than only in the docs. */
function serviceKeyNote(table: Table): string {
  const cols = table.primaryKey?.columns ?? [];
  const untyped = cols.filter((n) => {
    const c = table.columns?.find((x) => x.name === n);
    return !c || !serviceKeyExpressible(c);
  });
  const what =
    untyped.length === 1 ? `its column ${untyped[0]}` : `its columns ${untyped.join(', ')}`;
  return (
    `    // ${table.name} is keyed on (${cols.join(', ')}) and DRZL cannot type ${what}: the input\n` +
    `    // schema carries unknown there, which the service's typed key parameter does not accept.\n` +
    `    // Wire this to your own lookup.\n`
  );
}

/**
 * Spell the import of a generated service module.
 *
 * Two things this must not get wrong, both of which it did while the string was built by hand.
 *
 * `path.relative` returns a bare `services` whenever the services directory sits inside the
 * router's output directory. A specifier without a leading `./` is a *bare* specifier: Node
 * looks for a package of that name in node_modules and never considers the file next door. So
 * the prefix is added explicitly rather than relying on what `path.relative` happens to return.
 *
 * The extension then goes through `importSpecifier`, the same helper the router barrel uses, so
 * this specifier obeys `importExtension` exactly like every other one DRZL emits. Building it
 * by hand is how it came to be the single relative import in the output with no `.js`, failing
 * under `moduleResolution: node16` and `nodenext`.
 */
function serviceImportPath(
  outDir: string,
  servicesDir: string,
  singular: string,
  importExtension?: ImportExtension
): string {
  const rel = path.relative(outDir, servicesDir);
  const dir = !rel ? '.' : rel.startsWith('.') ? rel : `./${rel}`;
  return importSpecifier(`${dir}/${singular}Service.ts`, importExtension);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singularize = (s: string) =>
  s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s;

export interface ProcedureSpec {
  name: string;
  varName: string;
  code: string;
}
export interface ORPCTemplateHooks {
  filePath(
    table: Table,
    ctx: {
      outDir: string;
      naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' };
    }
  ): string;
  routerName(
    table: Table,
    ctx: { naming?: { routerSuffix?: string; procedureCase?: 'camel' | 'kebab' | 'snake' } }
  ): string;
  procedures(
    table: Table,
    ctx?: {
      databaseInjection?: {
        enabled?: boolean;
        databaseType?: string;
        databaseTypeImport?: { name: string; from: string };
      };
    }
  ): ProcedureSpec[];
  imports?(
    tables: Table[],
    ctx?: {
      outDir: string;
      servicesDir?: string;
      /** How to spell the extension of the service module this router imports. */
      importExtension?: ImportExtension;
      databaseInjection?: {
        enabled?: boolean;
        databaseType?: string;
        databaseTypeImport?: { name: string; from: string };
      };
    }
  ): string;
  header?(table: Table): string;
}

const servicesDirDefault = 'src/services';

import path from 'node:path';

const template: ORPCTemplateHooks = {
  filePath: (table, ctx) => {
    const suffix = ctx.naming?.routerSuffix ?? '';
    const base = `${table.tsName}${suffix}`;
    const toCase = (s: string) => {
      const parts = s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .split(/\s+/);
      const c = ctx.naming?.procedureCase ?? 'camel';
      if (c === 'kebab') return parts.map((p) => p.toLowerCase()).join('-');
      if (c === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
      return parts
        .map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()))
        .join('');
    };
    return `${ctx.outDir}/${toCase(base)}.ts`;
  },
  routerName: (table, ctx) => {
    const suffix = ctx.naming?.routerSuffix ?? '';
    const base = `${table.tsName}${suffix}`;
    const toCase = (s: string) => {
      const parts = s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .split(/\s+/);
      const c = ctx.naming?.procedureCase ?? 'camel';
      if (c === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
      // kebab invalid for identifiers -> camel
      return parts
        .map((p, i) => (i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()))
        .join('');
    };
    return toCase(base);
  },
  imports: (tables, ctx) => {
    const t = tables[0];
    const singular = singularize(t.tsName);
    const Service = `${cap(singular)}Service`;
    const outDir = ctx?.outDir ?? 'src/api';
    const servicesDir = (ctx as any)?.servicesDir ?? servicesDirDefault;
    const servicePath = serviceImportPath(
      outDir,
      servicesDir,
      singular,
      ctx?.importExtension
    );

    const isInjectionMode = ctx?.databaseInjection?.enabled === true;
    const dbType = ctx?.databaseInjection?.databaseType ?? 'any';

    if (isInjectionMode) {
      const typeImport = ctx?.databaseInjection?.databaseTypeImport
        ? `\nimport type { ${ctx.databaseInjection.databaseTypeImport.name} } from '${ctx.databaseInjection.databaseTypeImport.from}';`
        : '';
      return `import { os, ORPCError } from '@orpc/server'
import { z } from 'zod'
import { ${Service} } from '${servicePath}'
${typeImport}

export const dbMiddleware = os
  .$context<{ db?: ${dbType} }>()
  .middleware(async ({ context, next }) => {
    if (!context.db) {
      console.error('No database provided in context');
      throw new ORPCError('INTERNAL_SERVER_ERROR');
    }
    return next({
      context: {
        db: context.db
      }
    });
  });`;
    } else {
      return `import { os } from '@orpc/server'\nimport { z } from 'zod'\nimport { ${Service} } from '${servicePath}'`;
    }
  },
  header: (table) => `// Router for table: ${table.name}`,
  procedures: (table, ctx) => {
    const T = cap(table.tsName);
    const singular = singularize(table.tsName);
    const Service = `${cap(singular)}Service`;
    const isInjectionMode = ctx?.databaseInjection?.enabled === true;

    const make = (proc: string, varName: string, code: string): ProcedureSpec => ({
      name: proc,
      varName,
      code,
    });

    // The key facts every addressing body below is composed from. `@drzl/generator-service`
    // types one parameter per key column, in key order, so the call passes `input.<col>` for
    // each: `getById(input.id)`, `getById(input.isbn)`, `getById(input.orgId, input.userId)`.
    // A keyless table gets list and create only, because its service has nothing else, and a
    // key column DRZL cannot type gets a throwing stub rather than a call that does not
    // compile (the input schema carries unknown there, the service parameter is typed).
    const key = keyColumns(table);
    const keyable = !!key && key.every(serviceKeyExpressible);
    const keyArgs = key ? key.map(serviceKeyArg).join(', ') : '';
    const keyFields = key ? key.map((c) => `${c.name}: ${zodKeyExpr(c)}`).join(', ') : '';
    const keyInput = `z.object({ ${keyFields} })`;
    const updateInput = `z.object({ ${keyFields}, data: z.any() })`;

    const stub = (proc: string, varName: string, input: string) => {
      const chain = isInjectionMode
        ? `os\n  .use(dbMiddleware)\n  .input(${input})`
        : `os\n  .input(${input})`;
      return `const ${varName} = ${chain}\n  .handler(async () => {\n${serviceKeyNote(table)}    throw new Error('Not implemented: ${proc} ${table.tsName}.');\n  });`;
    };

    if (isInjectionMode) {
      // Database injection mode - use middleware and context
      const wired = (varName: string, input: string, call: string) =>
        `const ${varName} = os\n  .use(dbMiddleware)\n  .input(${input})\n  .handler(async ({ context, input }) => {\n    return await ${call};\n  });`;
      const procs = [
        make(
          'list',
          `list${T}`,
          `const list${T} = os\n  .use(dbMiddleware)\n  .handler(async ({ context }) => {\n    return await ${Service}.getAll(context.db);\n  });`
        ),
      ];
      if (key) {
        procs.push(
          make(
            'get',
            `get${T}`,
            keyable
              ? wired(`get${T}`, keyInput, `${Service}.getById(context.db, ${keyArgs})`)
              : stub('get', `get${T}`, keyInput)
          )
        );
      }
      procs.push(
        make(
          'create',
          `create${T}`,
          `const create${T} = os\n  .use(dbMiddleware)\n  .input(z.any())\n  .handler(async ({ context, input }) => {\n    return await ${Service}.create(context.db, input);\n  });`
        )
      );
      if (key) {
        procs.push(
          make(
            'update',
            `update${T}`,
            keyable
              ? wired(
                  `update${T}`,
                  updateInput,
                  `${Service}.update(context.db, ${keyArgs}, input.data)`
                )
              : stub('update', `update${T}`, updateInput)
          ),
          make(
            'delete',
            `delete${T}`,
            keyable
              ? wired(`delete${T}`, keyInput, `${Service}.delete(context.db, ${keyArgs})`)
              : stub('delete', `delete${T}`, keyInput)
          )
        );
      }
      return procs;
    } else {
      // Traditional mode - backward compatibility
      const wired = (varName: string, input: string, call: string) =>
        `const ${varName} = os\n  .input(${input})\n  .handler(async ({ input }) => {\n    return await ${call};\n  });`;
      const procs = [
        make(
          'list',
          `list${T}`,
          `const list${T} = os.handler(async () => {\n  return await ${Service}.getAll();\n});`
        ),
      ];
      if (key) {
        procs.push(
          make(
            'get',
            `get${T}`,
            keyable
              ? wired(`get${T}`, keyInput, `${Service}.getById(${keyArgs})`)
              : stub('get', `get${T}`, keyInput)
          )
        );
      }
      procs.push(
        make(
          'create',
          `create${T}`,
          `const create${T} = os\n  .input(z.any())\n  .handler(async ({ input }) => {\n    return await ${Service}.create(input);\n  });`
        )
      );
      if (key) {
        procs.push(
          make(
            'update',
            `update${T}`,
            keyable
              ? wired(`update${T}`, updateInput, `${Service}.update(${keyArgs}, input.data)`)
              : stub('update', `update${T}`, updateInput)
          ),
          make(
            'delete',
            `delete${T}`,
            keyable
              ? wired(`delete${T}`, keyInput, `${Service}.delete(${keyArgs})`)
              : stub('delete', `delete${T}`, keyInput)
          )
        );
      }
      return procs;
    }
  },
};

export default template;
