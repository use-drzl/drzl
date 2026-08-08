// Minimal local shapes to avoid cross-package DTS complexity. The runtime object the generator
// passes is the full analyzer table; the key fields are optional because a hand-built
// `{ name, tsName }` is still a valid table, one that reads as keyless.
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The columns that address one row, or `null` when nothing does: the same reading of
 * `primaryKey` as every route generator. This template used to spell every addressing input as
 * `z.object({ id: z.number() })`, which names a column that may not exist and types it as a
 * number when it may be a varchar; a keyless table got the three procedures anyway.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length || !table.columns) return null;
  const cols = names.map((n) => table.columns!.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/** The zod spelling of one key column. The generator rewrites these inputs into the configured validation library; this is what direct consumers of the hooks read. */
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
              : 'z.unknown()';
  return c.nullable ? `${base}.nullable()` : base;
}

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
    // The addressing input, from the real key columns: `{ id: z.number() }` for the integer key
    // this template always spelled, but equally `{ isbn: z.string() }` or a composite key's two
    // columns. A table with no primary key loses get, update and delete rather than gaining a
    // fictional `id`; create stays, because inserting a row does not require being able to
    // address it afterwards.
    const key = keyColumns(table);
    const keyFields = key ? key.map((c) => `${c.name}: ${zodKeyExpr(c)}`).join(', ') : '';
    const procs = [
      make('list', listVar, `const ${listVar} = os.handler(async () => { return []; });`),
    ];
    if (key) {
      procs.push(
        make(
          'get',
          getVar,
          `const ${getVar} = os.input(z.object({ ${keyFields} })).handler(async ({ input: _input }) => { return null; });`
        )
      );
    }
    // create (and update below) throw rather than returning the input. The generator declares
    // `.output(SelectSchema)` on both, and the input is the *insert* shape, where generated
    // and defaulted columns are optional and in select they are required. Returning it did
    // not typecheck, and would not have been correct if it had: a created row carries columns
    // the input never had. A body that only throws has type `never`, so it honours the
    // declared contract and says plainly that the work is not done.
    procs.push(
      make(
        'create',
        createVar,
        `const ${createVar} = os.input(z.any()).handler(async ({ input: _input }) => { throw new Error('Not implemented: create ${table.tsName}. Persist the input and return the created row.'); });`
      )
    );
    if (key) {
      procs.push(
        make(
          'update',
          updateVar,
          `const ${updateVar} = os.input(z.object({ ${keyFields}, data: z.any() })).handler(async ({ input: _input }) => { throw new Error('Not implemented: update ${table.tsName}. Apply the patch and return the updated row.'); });`
        ),
        make(
          'delete',
          deleteVar,
          `const ${deleteVar} = os.input(z.object({ ${keyFields} })).handler(async ({ input: _input }) => { return true; });`
        )
      );
    }
    return procs;
  },
};

export default template;
