// Minimal local Table shape to avoid cross-package DTS complexity
interface Table {
  name: string;
  tsName: string;
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
  procedures(table: Table, ctx?: { databaseInjection?: { enabled?: boolean; databaseType?: string } }): ProcedureSpec[];
  imports?(tables: Table[], ctx?: { outDir: string; servicesDir?: string; databaseInjection?: { enabled?: boolean; databaseType?: string } }): string;
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
    const rel = path.relative(outDir, servicesDir) || '.';
    
    const isInjectionMode = ctx?.databaseInjection?.enabled === true;
    const dbType = ctx?.databaseInjection?.databaseType ?? 'any';
    
    if (isInjectionMode) {
      return `import { os, ORPCError } from '@orpc/server'
import { z } from 'zod'
import { ${Service} } from '${rel}/${singular}Service'

export const dbMiddleware = os
  .$context<{ db?: ${dbType} }>()
  .middleware(async ({ context, next }) => {
    if (!context.db) {
      console.error('No database provided in context');
      throw new ORPCError({ code: 'INTERNAL_SERVER_ERROR' });
    }
    return next({
      context: {
        db: context.db
      }
    });
  });`;
    } else {
      return `import { os } from '@orpc/server'\nimport { z } from 'zod'\nimport { ${Service} } from '${rel}/${singular}Service'`;
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
    
    if (isInjectionMode) {
      // Database injection mode - use middleware and context
      return [
        make(
          'list',
          `list${T}`,
          `const list${T} = os\n  .use(dbMiddleware)\n  .handler(async ({ context }) => {\n    return await ${Service}.getAll(context.db);\n  });`
        ),
        make(
          'get',
          `get${T}`,
          `const get${T} = os\n  .use(dbMiddleware)\n  .input(z.object({ id: z.number() }))\n  .handler(async ({ context, input }) => {\n    return await ${Service}.getById(context.db, input.id);\n  });`
        ),
        make(
          'create',
          `create${T}`,
          `const create${T} = os\n  .use(dbMiddleware)\n  .input(z.any())\n  .handler(async ({ context, input }) => {\n    return await ${Service}.create(context.db, input);\n  });`
        ),
        make(
          'update',
          `update${T}`,
          `const update${T} = os\n  .use(dbMiddleware)\n  .input(z.object({ id: z.number(), data: z.any() }))\n  .handler(async ({ context, input }) => {\n    return await ${Service}.update(context.db, input.id, input.data);\n  });`
        ),
        make(
          'delete',
          `delete${T}`,
          `const delete${T} = os\n  .use(dbMiddleware)\n  .input(z.object({ id: z.number() }))\n  .handler(async ({ context, input }) => {\n    return await ${Service}.delete(context.db, input.id);\n  });`
        ),
      ];
    } else {
      // Traditional mode - backward compatibility
      return [
        make(
          'list',
          `list${T}`,
          `const list${T} = os.handler(async () => {\n  return await ${Service}.getAll();\n});`
        ),
        make(
          'get',
          `get${T}`,
          `const get${T} = os\n  .input(z.object({ id: z.number() }))\n  .handler(async ({ input }) => {\n    return await ${Service}.getById(input.id);\n  });`
        ),
        make(
          'create',
          `create${T}`,
          `const create${T} = os\n  .input(z.any())\n  .handler(async ({ input }) => {\n    return await ${Service}.create(input);\n  });`
        ),
        make(
          'update',
          `update${T}`,
          `const update${T} = os\n  .input(z.object({ id: z.number(), data: z.any() }))\n  .handler(async ({ input }) => {\n    return await ${Service}.update(input.id, input.data);\n  });`
        ),
        make(
          'delete',
          `delete${T}`,
          `const delete${T} = os\n  .input(z.object({ id: z.number() }))\n  .handler(async ({ input }) => {\n    return await ${Service}.delete(input.id);\n  });`
        ),
      ];
    }
  },
};

export default template;
