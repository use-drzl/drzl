// Minimal local Table shape to avoid cross-package DTS complexity
interface Table {
  name: string;
  tsName: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  procedures(table: Table): ProcedureSpec[];
  imports?(tables: Table[]): string;
  prelude?(tables: Table[]): string;
  header?(table: Table): string;
}

const template: ORPCTemplateHooks = {
  filePath: (table, ctx) => {
    const suffix = ctx.naming?.routerSuffix ?? '';
    const base = `${table.tsName}${suffix}`;
    const procCase = ctx.naming?.procedureCase;
    const toCase = (s: string) => {
      if (!procCase) return s;
      const parts = s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .split(/\s+/);
      if (procCase === 'camel')
        return parts
          .map((p, i) =>
            i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()
          )
          .join('');
      if (procCase === 'kebab') return parts.map((p) => p.toLowerCase()).join('-');
      if (procCase === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
      return s;
    };
    const fileBase = toCase(base);
    return `${ctx.outDir}/${fileBase}.ts`;
  },
  routerName: (table, ctx) => {
    const suffix = ctx.naming?.routerSuffix ?? '';
    const base = `${table.tsName}${suffix}`;
    const procCase = ctx.naming?.procedureCase;
    const toCase = (s: string) => {
      if (!procCase) return s;
      const parts = s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .split(/\s+/);
      // Kebab is invalid for identifiers; treat as camel here
      if (procCase === 'camel' || procCase === 'kebab')
        return parts
          .map((p, i) =>
            i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()
          )
          .join('');
      if (procCase === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
      return s;
    };
    return toCase(base);
  },
  imports: () => `import { os } from '@orpc/server'\nimport { z } from 'zod'`,
  prelude: () => '',
  header: (table) => `// Router for table: ${table.name}`,
  procedures: (table) => {
    const T = cap(table.tsName);
    const make = (proc: string, varName: string, code: string): ProcedureSpec => ({
      name: proc,
      varName,
      code,
    });
    const listVar = `list${T}`;
    const getVar = `get${T}`;
    const createVar = `create${T}`;
    const updateVar = `update${T}`;
    const deleteVar = `delete${T}`;
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
};

export default template;
