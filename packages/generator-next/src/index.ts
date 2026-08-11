import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { AffixOptions, ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  importSpecifier,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
} from '@drzl/validation-core';

/**
 * Next.js server actions, one `'use server'` module per table.
 *
 * Why this is a generator rather than an example. DRZL already documents this pattern and ships a
 * runnable app under `examples/nextjs-server-actions`, and what neither can do is the half that is
 * mechanical and easy to get wrong: reading the form. A schema describes a *row*, and a form posts
 * *strings*, so between the two sits a conversion per column that nobody writes correctly by hand.
 *
 * The measurement that made this worth generating, taken on 2026-08-11 against zod 4.4.3, valibot
 * 1.1 and arktype 2: **every value a browser posts from a date input is rejected by the schemas
 * DRZL emits.** `<input type="date">` posts `2026-08-11`, `<input type="datetime-local">` posts
 * `2026-08-11T14:30`, and `z.iso.datetime()` and `v.isoTimestamp()` refuse all four spellings; only
 * a hand-typed `2026-08-11T14:30:00Z` gets through. A form wired straight to a generated schema
 * therefore cannot submit a date at all. `dateField` below is what closes that, and it is the same
 * class of defect the Hono generator's `dateInput` closed for JSON bodies.
 *
 * The other three are smaller and have the same shape: an empty number box posts `''` and must
 * become `NaN` rather than `0`, because `0` is a confident answer to a question nobody asked; an
 * unchecked checkbox is absent from `FormData` entirely rather than posting `false`; and a blank
 * optional text box posts `''`, which is a value the column would store rather than the absence the
 * user meant.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported action names. */
  routerSuffix?: string;
  /** Casing applied to file names and identifiers. */
  procedureCase?: Case;
}

/** The shared module's filename stem, and the barrel's. */
export const HELPERS_MODULE = 'form-state';
export const BARREL_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension. Defaults to `'js'`,
   * the only form that resolves under every `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
  /** Where the generated files go, when that is not the filesystem. */
  fileSink?: FileSink;
}

type Lib = NonNullable<NonNullable<GenerateOptions['validation']>['library']>;

/** How one library is imported, parsed and asked what went wrong. */
interface LibDialect {
  /** The import the actions module needs, or `''` where the schema alone is enough. */
  runtimeImport: string;
  /**
   * The statement that parses `input` against `schema`, leaving `ok` and `issues` in scope.
   *
   * Spelled per library because the three genuinely differ in shape rather than in spelling: zod
   * returns a discriminated union from a method on the schema, valibot returns one from a free
   * function taking the schema first, and arktype returns either the value or an `ArkErrors`
   * instance and has no result object at all.
   */
  parse: (schema: string) => string[];
  /** The type-only import `fieldErrorsFor` needs, which differs per library. */
  errorsImport: string;
  /** `fieldErrorsFor` itself, given this library's issue shape. */
  errorsBody: string;
}

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    runtimeImport: '',
    parse: (schema) => [
      `const result = ${schema}.safeParse(input);`,
      `if (!result.success) {`,
      `  return { status: 'rejected', errors: fieldErrorsFor(result.error.issues) };`,
      `}`,
    ],
    errorsImport: "import type { z } from 'zod';",
    errorsBody: `/**
 * A failed parse, as messages keyed by the form field they belong under.
 *
 * The path's last key is the column, which is also the input's \`name\`. An issue with an empty
 * path is a whole-row check rather than a field, and lands under \`form\` so it is rendered rather
 * than dropped.
 */
export function fieldErrorsFor(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path.at(-1) ?? '') || 'form';
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}`,
  },
  valibot: {
    runtimeImport: "import * as v from 'valibot';",
    parse: (schema) => [
      `const result = v.safeParse(${schema}, input);`,
      `if (!result.success) {`,
      `  return { status: 'rejected', errors: fieldErrorsFor(result.issues) };`,
      `}`,
    ],
    errorsImport: "import type * as v from 'valibot';",
    errorsBody: `/**
 * A failed parse, as messages keyed by the form field they belong under.
 *
 * A valibot path is a list of *objects* rather than of keys, so the column is \`.key\` on the last
 * of them. An issue with no path at all is a whole-row check and lands under \`form\`.
 */
export function fieldErrorsFor(
  issues: readonly v.BaseIssue<unknown>[]
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = String(issue.path?.at(-1)?.key ?? '') || 'form';
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}`,
  },
  arktype: {
    runtimeImport: "import { type } from 'arktype';",
    parse: (schema) => [
      `const result = ${schema}(input);`,
      `if (result instanceof type.errors) {`,
      `  return { status: 'rejected', errors: fieldErrorsFor(result) };`,
      `}`,
    ],
    errorsImport: "import type { ArkErrors } from 'arktype';",
    errorsBody: `/**
 * A failed parse, as messages keyed by the form field they belong under.
 *
 * ArkType reports a failure as an \`ArkErrors\` array rather than through a result object, and each
 * entry carries the path it came from. An entry with an empty path is a whole-row check.
 */
export function fieldErrorsFor(errors_: ArkErrors): FieldErrors {
  const errors: FieldErrors = {};
  for (const error of errors_) {
    const key = String(error.path.at(-1) ?? '') || 'form';
    (errors[key] ??= []).push(error.message);
  }
  return errors;
}`,
  },
};

/** Where the parsed row lands, which is not the same property in all three. */
const PARSED_VALUE: Record<Lib, string> = {
  zod: 'result.data',
  valibot: 'result.output',
  arktype: 'result',
};

const q = (v: string) => JSON.stringify(v);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * The reader each column's value comes through, named for what the browser posts rather than for
 * the column's TypeScript type.
 *
 * Every one of these is emitted into the shared module whatever the schema contains, because they
 * are a fixed, small set and an unused *export* is not an error the way an unused import is. What
 * varies per column is which one is called.
 */
function readerFor(column: Column): string {
  if (column.enumValues && column.enumValues.length) {
    // A select posts one of its option values, so it is text. Nullable means the form carries a
    // blank option, which is the absence rather than the empty string.
    return column.nullable ? 'nullableTextField' : 'textField';
  }
  switch (column.tsType) {
    case 'number':
      return column.nullable ? 'nullableNumberField' : 'numberField';
    case 'boolean':
      return 'booleanField';
    case 'Date':
      return column.nullable ? 'nullableDateField' : 'dateField';
    case 'bigint':
      // Kept as the digit string the emitted schema checks with a regex, rather than converted:
      // a bigint past 2^53 does not survive a trip through `Number`.
      return column.nullable ? 'nullableTextField' : 'textField';
    case 'string':
      return column.nullable ? 'nullableTextField' : 'textField';
    default:
      // json, binary and anything the analyzer could not type. A textarea posting JSON is the only
      // form spelling of these there is, so the raw string is handed over and the schema decides.
      return column.nullable ? 'nullableTextField' : 'textField';
  }
}

/** The columns a create action reads, which is every one the database does not fill in. */
function createColumns(table: Table): Column[] {
  return table.columns.filter((c) => !c.isGenerated);
}

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * Same rule as every other DRZL generator: a table with no primary key loses the actions that
 * would have needed one rather than gaining a fictional `id`.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
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

/** `createUsers`, with `kebab` falling back to camel since `-` is not valid in an identifier. */
function actionName(verb: string, table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${verb}${cap(base)}`;
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class NextGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    const ctx: RenderContext = { out };
    await fs.mkdir(out, { recursive: true });

    const files: string[] = [];
    /**
     * `directive` leads the file, ahead of the header comment.
     *
     * A directive prologue is defined as the leading run of string-literal statements and comments
     * are not statements, so a banner above `'use server'` is legal JavaScript. It is emitted first
     * anyway: what reads this is Next's bundler rather than a JS engine, the failure mode if it
     * ever disagreed is silent (the exports become ordinary functions and a client component
     * calling one fails at runtime), and every Next document and DRZL's own example put the
     * directive on line 1. There is nothing to gain from being the one that does not.
     */
    const write = async (filePath: string, content: string, directive = '') => {
      const formatted = await formatCode(
        directive + buildHeader(opts.outputHeader) + content,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    };

    const helpersPath = path.join(out, `${HELPERS_MODULE}.ts`);
    const barrelPath = path.join(out, `${BARREL_MODULE}.ts`);
    const reserved = new Map<string, string>([
      [helpersPath, `${HELPERS_MODULE}.ts`],
      [barrelPath, `${BARREL_MODULE}.ts`],
    ]);

    /**
     * The tables that get a module, which is not every table.
     *
     * A server action is a mutation. A materialized view refuses every write, so it has no action
     * to define, and emitting a module for one produced a file whose only content was imports:
     * `noUnusedLocals` reported all of them, which is how this branch was found. Reads are not the
     * missing half either, because a Next server component queries directly rather than through an
     * action.
     */
    const writable = this.analysis.tables.filter((t) => !t.readOnly);

    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = writable.length;
    let index = 0;
    for (const table of writable) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      const clash = reserved.get(filePath);
      if (clash) {
        throw new Error(
          `@drzl/generator-next: the actions for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${clash} this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderActions(table, opts, ctx, lib), USE_SERVER);
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(helpersPath, renderHelpers(lib));
    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default NextGenerator;

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

/**
 * The shared module: the state a form reads, and the readers that turn a post into a row.
 *
 * Separate from the action modules and deliberately *not* `'use server'`, because such a file may
 * export only async functions. A type would be erased and get away with it; `EMPTY_FORM_STATE` is a
 * `const` and would not, and neither would any of the readers below.
 */
function renderHelpers(lib: Lib): string {
  const d = LIBS[lib];
  return `// Generated by @drzl/generator-next
// The form state every action returns, and the readers that turn a post into a row.
${d.errorsImport}

/** Form field name to the messages to render under it. */
export type FieldErrors = Record<string, string[]>;

export interface FormState {
  status: 'idle' | 'created' | 'updated' | 'deleted' | 'rejected';
  errors: FieldErrors;
}

export const EMPTY_FORM_STATE: FormState = { status: 'idle', errors: {} };

${d.errorsBody}

/** A text input's value, or the empty string when the field is absent. */
export function textField(data: FormData, name: string): string {
  const raw = data.get(name);
  return typeof raw === 'string' ? raw : '';
}

/**
 * The same, with a blank box read as absence rather than as the empty string.
 *
 * For a nullable column, where \`''\` is a value the database would store and almost never the one
 * the person leaving the box empty meant.
 */
export function nullableTextField(data: FormData, name: string): string | null {
  const raw = textField(data, name);
  return raw.trim() === '' ? null : raw;
}

/**
 * A number input's value, and \`NaN\` for an empty box.
 *
 * \`NaN\` rather than \`0\`, and rather than coercing inside the schema: an empty box coerced to
 * zero is reported against whatever bound zero happens to break, which is a confident answer to a
 * question nobody asked. \`NaN\` is refused as a number, which is the truth about an empty box.
 */
export function numberField(data: FormData, name: string): number {
  const raw = textField(data, name);
  return raw.trim() === '' ? Number.NaN : Number(raw);
}

/** The same, with a blank box read as absence. */
export function nullableNumberField(data: FormData, name: string): number | null {
  const raw = textField(data, name);
  return raw.trim() === '' ? null : Number(raw);
}

/**
 * A checkbox.
 *
 * An unchecked checkbox is absent from \`FormData\` entirely rather than posting \`false\`, so the
 * question is presence and not value. \`'false'\` and \`'off'\` are refused as well, for the common
 * pattern of a hidden input carrying the unchecked value ahead of the box.
 */
export function booleanField(data: FormData, name: string): boolean {
  const raw = data.get(name);
  if (typeof raw !== 'string') return false;
  return raw !== '' && raw !== 'false' && raw !== 'off';
}

/**
 * A date or datetime input, as the instant the generated schemas accept.
 *
 * This is the reader that has to exist. Measured on 2026-08-11 against zod 4.4.3, valibot 1.1 and
 * arktype 2: \`<input type="date">\` posts \`2026-08-11\`, \`<input type="datetime-local">\` posts
 * \`2026-08-11T14:30\`, and every one of those spellings is **refused** by the schemas DRZL emits
 * for a date column, which accept only a full instant such as \`2026-08-11T14:30:00Z\`. A form
 * wired straight to a generated schema could not submit a date at all.
 *
 * A value the browser posts carries no timezone, so one has to be chosen, and this reads it as
 * UTC. Not as the server's local zone, which is the other candidate: that makes the same submission
 * mean two different instants depending on which region the server happens to run in.
 *
 * Anything that does not match, including a value that already carries a zone and anything that is
 * not a date at all, is handed to the schema unchanged, so the schema stays the thing that decides
 * what is valid.
 */
export function dateField(data: FormData, name: string): string {
  const raw = textField(data, name);
  const m = /^(\\d{4}-\\d{2}-\\d{2})(?:T(\\d{2}:\\d{2})(:\\d{2})?(\\.\\d+)?)?$/.exec(raw);
  if (!m) return raw;
  return \`\${m[1]}T\${m[2] ?? '00:00'}\${m[3] ?? ':00'}\${m[4] ?? '.000'}Z\`;
}

/** The same, with a blank box read as absence. */
export function nullableDateField(data: FormData, name: string): string | null {
  return textField(data, name).trim() === '' ? null : dateField(data, name);
}
`;
}

/** The directive, and the blank line that keeps a formatter from folding it into the banner. */
const USE_SERVER = "'use server';\n\n";

function renderActions(
  table: Table,
  opts: GenerateOptions,
  ctx: RenderContext,
  lib: Lib
): string {
  const d = LIBS[lib];
  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;

  const writable = !table.readOnly;
  const key = keyColumns(table);

  const helpers = new Set<string>();
  const field = (column: Column, indent: string) => {
    const reader = readerFor(column);
    helpers.add(reader);
    return `${indent}${objectKey(column.name)}: ${reader}(data, ${q(column.name)}),`;
  };
  /** The same, guarded on the form having carried the field at all. */
  const presentField = (column: Column, indent: string) => {
    const reader = readerFor(column);
    helpers.add(reader);
    const name = q(column.name);
    return (
      `${indent}if (data.has(${name})) input[${name}] = ${reader}(data, ${name});`
    );
  };

  const actions: string[] = [];

  if (writable) {
    const cols = createColumns(table);
    actions.push(
      [
        `/**`,
        ` * Create one ${table.name} row from a posted form.`,
        ` *`,
        ` * The shape \`useActionState\` expects: the previous state first, the form second.`,
        ` */`,
        `export async function ${actionName('create', table, opts.naming)}(`,
        `  _prev: FormState,`,
        `  data: FormData`,
        `): Promise<FormState> {`,
        `  const input = {`,
        ...cols.map((c) => field(c, '    ')),
        `  };`,
        ``,
        ...d.parse(insertName).map((l) => `  ${l}`),
        ``,
        `  // The validated row is at \`${PARSED_VALUE[lib]}\`. Write it, then revalidate the paths`,
        `  // that render it: \`revalidatePath\` from 'next/cache'.`,
        `  throw new Error('Not implemented: create ${table.tsName}.');`,
        `}`,
      ].join('\n')
    );
  }

  if (writable && key) {
    const patchCols = table.columns.filter((c) => !c.isGenerated);
    actions.push(
      [
        `/**`,
        ` * Update one ${table.name} row, addressed by ${keyPhrase(key)}.`,
        ` *`,
        ` * The key comes out of the same form as the values, which is what a hidden input is for:`,
        ` * \`<input type="hidden" name="${key[0].name}" value={row.${key[0].name}} />\`.`,
        ` *`,
        ` * Only the fields the form actually posted reach the patch. An update schema makes every`,
        ` * column optional, so a field the form left out has to be *absent* rather than present and`,
        ` * blank: reading every column unconditionally would send the empty string for each box the`,
        ` * form does not render and overwrite those columns with it.`,
        ` */`,
        `export async function ${actionName('update', table, opts.naming)}(`,
        `  _prev: FormState,`,
        `  data: FormData`,
        `): Promise<FormState> {`,
        `  const input: Record<string, unknown> = {};`,
        ...patchCols.map((c) => presentField(c, '  ')),
        ``,
        ...d.parse(updateName).map((l) => `  ${l}`),
        ``,
        `  const where = {`,
        ...key.map((c) => field(c, '    ')),
        `  };`,
        ``,
        `  // The validated patch is at \`${PARSED_VALUE[lib]}\` and the row it applies to is at`,
        `  // \`where\`. Write it, then revalidate the paths that render it with \`revalidatePath\`.`,
        `  throw new Error(\`Not implemented: update ${table.tsName} \${JSON.stringify(where)}.\`);`,
        `}`,
      ].join('\n')
    );

    actions.push(
      [
        `/** Delete one ${table.name} row, addressed by ${keyPhrase(key)}. */`,
        `export async function ${actionName('delete', table, opts.naming)}(`,
        `  _prev: FormState,`,
        `  data: FormData`,
        `): Promise<FormState> {`,
        `  const where = {`,
        ...key.map((c) => field(c, '    ')),
        `  };`,
        ``,
        `  throw new Error(\`Not implemented: delete ${table.tsName} \${JSON.stringify(where)}.\`);`,
        `}`,
      ].join('\n')
    );
  }

  const body = actions.join('\n\n');

  const imports: string[] = [];
  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const wantedSchemas = [
    ['insert', insertName],
    ['update', updateName],
  ].filter(([, local]) => body.includes(local)) as Array<['insert' | 'update', string]>;

  if (wantedSchemas.length) {
    if (useShared) {
      const sharedAffix = resolveAffix({
        affix: opts.validation?.affix,
        schemaSuffix: opts.validation?.schemaSuffix,
      });
      const spec = resolveConfiguredImport(
        opts.validation!.importPath!,
        ctx.out,
        process.cwd(),
        opts.importExtension
      );
      const names = wantedSchemas
        .map(([mode, local]) => {
          const exported = schemaName(mode, table.tsName, sharedAffix);
          return exported === local ? local : `${exported} as ${local}`;
        })
        .join(', ');
      imports.push(`import { ${names} } from '${spec}';`);
    } else {
      throw new Error(
        `@drzl/generator-next: this generator has no schemas of its own to emit. Its actions parse ` +
          `the schemas a validation generator wrote, so it needs validation.useShared and ` +
          `validation.importPath pointing at that generator's output directory. Add a "zod", ` +
          `"valibot" or "arktype" generator to the config and point this one at its path.`
      );
    }
  }

  if (d.runtimeImport) imports.push(d.runtimeImport);

  const helperSpec = importSpecifier(`./${HELPERS_MODULE}.ts`, opts.importExtension);
  const usedHelpers = [...helpers].sort();
  // `FormState` is a type and travels in the same statement, since a `'use server'` module may not
  // export a type but may certainly import one.
  imports.push(
    `import { type FormState, fieldErrorsFor${usedHelpers.length ? ', ' + usedHelpers.join(', ') : ''} } from '${helperSpec}';`
  );

  return `// Generated by @drzl/generator-next
// Server actions for table: ${table.name}
${imports.join('\n')}

${body}
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const specs = modules.map((m) =>
    importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    )
  );
  const helperSpec = importSpecifier(`./${HELPERS_MODULE}.ts`, opts.importExtension);
  const reExports = specs.map((s) => `export * from '${s}';`).join('\n');

  return `// Generated by @drzl/generator-next
// Every generated action, and the state they share.
//
// Not a 'use server' module itself, and it does not need to be: the directive belongs to the file
// that *defines* an action, and re-exporting one through an ordinary module keeps it callable.
export * from '${helperSpec}';
${reExports || '// No writable tables in the analysis, so there are no actions to re-export.'}
`;
}
