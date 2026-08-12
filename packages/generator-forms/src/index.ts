import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Table } from '@drzl/analyzer';
import type { AffixOptions, ImportExtension } from '@drzl/validation-core';
import {
  fieldFacts,
  formatCode,
  importSpecifier,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
  type FieldFacts,
} from '@drzl/validation-core';

/**
 * Form resolvers and per-field input metadata, one module per table.
 *
 * Two halves, and the second is the one that is hard to get anywhere else.
 *
 * **The resolver** wires an emitted schema into a form library. Measured 2026-08-12:
 *
 *   react-hook-form   needs a resolver. `standardSchemaResolver` from `@hookform/resolvers`
 *                     serves zod, valibot and arktype with one import; TypeBox and Effect expose
 *                     no `~standard` and have dedicated resolvers in the same package.
 *   TanStack Form     needs none. A Standard Schema goes straight into
 *                     `validators: { onChange: schema }` and the errors come back keyed per field.
 *
 * **The field metadata** is the `min`, `max`, `maxlength`, `pattern`, options and `required` the
 * column really carries, so an input element states them without a second source of truth. It comes
 * from `fieldFacts` in `@drzl/validation-core` rather than from the column directly, and that
 * distinction is the whole point: `Column.min` and `Column.max` are the column's *type* range, and a
 * `CHECK` does not narrow them. Measured, a column with `check('adult', age >= 18)` still reports
 * `min: '-2147483648'`. An input rendered from that would carry a bound that is not one, while the
 * schema beside it enforced 18. `fieldFacts` performs the same fold the validation generators do, in
 * the one place they can all share, so the two cannot disagree.
 */

/** Which form library the emitted modules are for. */
export type FormTarget = 'react-hook-form' | 'tanstack-form' | 'both';

/** The libraries whose schemas expose `~standard`, and so share one resolver. */
const STANDARD_LIBS = new Set(['zod', 'valibot', 'arktype']);

/** Where a resolver comes from, per library, measured against `@hookform/resolvers` 5.7.1. */
const RESOLVERS: Record<string, { specifier: string; fn: string }> = {
  zod: { specifier: '@hookform/resolvers/standard-schema', fn: 'standardSchemaResolver' },
  valibot: { specifier: '@hookform/resolvers/standard-schema', fn: 'standardSchemaResolver' },
  arktype: { specifier: '@hookform/resolvers/standard-schema', fn: 'standardSchemaResolver' },
  typebox: { specifier: '@hookform/resolvers/typebox', fn: 'typeboxResolver' },
  effect: { specifier: '@hookform/resolvers/effect-ts', fn: 'effectTsResolver' },
};

/** The barrel's filename stem. */
export const FORMS_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  /** Which library to emit for. Defaults to `react-hook-form`. */
  target?: FormTarget;
  /**
   * Which operations get a resolver. Defaults to insert and update.
   *
   * `select` is offered because a filter form is a form too, but it is off by default: the select
   * schema describes a row that came *out* of the database, and validating user input against it
   * asks for the generated columns a form never supplies.
   */
  modes?: Array<'insert' | 'update' | 'select'>;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype' | 'typebox' | 'effect';
    importPath?: string;
    affix?: AffixOptions;
    schemaSuffix?: string;
  };
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  fileSink?: FileSink;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
}

type Mode = 'insert' | 'update' | 'select';

const DEFAULT_MODES: Mode[] = ['insert', 'update'];

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One field's facts, as the object literal the emitted module carries. */
function renderField(f: FieldFacts, indent: string): string {
  const pad = `${indent}  `;
  const lines: string[] = [`${indent}${JSON.stringify(f.name)}: {`];
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    lines.push(`${pad}${key}: ${JSON.stringify(value)},`);
  };
  put('control', f.control);
  put('required', f.required);
  put('nullable', f.nullable);
  put('maxLength', f.maxLength);
  put('min', f.min);
  put('max', f.max);
  put('exclusiveMin', f.exclusiveMin);
  put('exclusiveMax', f.exclusiveMax);
  put('integer', f.integer);
  put('options', f.options);
  put('pattern', f.pattern);
  put('defaultValue', f.defaultValue);
  lines.push(`${indent}},`);
  return lines.join('\n');
}

export class FormsGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions): Promise<{ files: string[] }> {
    if (!opts.validation?.useShared || !opts.validation?.importPath) {
      throw new Error(
        '@drzl/generator-forms: a resolver is nothing without a schema, so it needs ' +
          "validation.useShared and validation.importPath pointing at a validation generator's " +
          'output directory. Add one to the config, or drop this generator.'
      );
    }

    const library = opts.validation.library ?? 'zod';
    const resolver = RESOLVERS[library];
    if (!resolver) {
      throw new Error(
        `@drzl/generator-forms: no react-hook-form resolver is published for "${library}". ` +
          `The libraries with one are ${Object.keys(RESOLVERS).join(', ')}.`
      );
    }

    const target: FormTarget = opts.target ?? 'react-hook-form';
    const wantsResolver = target === 'react-hook-form' || target === 'both';
    const wantsFormOptions = target === 'tanstack-form' || target === 'both';
    // TanStack Form takes the schema itself, and only a Standard Schema. TypeBox and Effect expose
    // none, so asking for that target with either is a config that cannot work; saying so beats
    // emitting an options object the form will ignore.
    if (wantsFormOptions && !STANDARD_LIBS.has(library)) {
      throw new Error(
        `@drzl/generator-forms: TanStack Form takes a Standard Schema directly, and "${library}" ` +
          `exposes no \`~standard\`. Use ${[...STANDARD_LIBS].join(', ')} for this target, or ` +
          `target react-hook-form, which has a dedicated ${resolver.fn} for it.`
      );
    }

    const modes = (opts.modes ?? DEFAULT_MODES).filter((m): m is Mode =>
      ['insert', 'update', 'select'].includes(m)
    );
    if (!modes.length) {
      throw new Error('@drzl/generator-forms: `modes` is empty, so there is nothing to emit.');
    }

    const affix = resolveAffix({
      affix: opts.validation.affix,
      schemaSuffix: opts.validation.schemaSuffix,
    });

    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    await fs.mkdir(out, { recursive: true });

    const spec = resolveConfiguredImport(
      opts.validation.importPath,
      out,
      process.cwd(),
      opts.importExtension
    );

    const files: string[] = [];
    const tables = this.analysis.tables;
    const written: Array<{ stem: string }> = [];

    for (const [index, table] of tables.entries()) {
      // A relation that refuses writes has no insert or update schema to resolve against, so a
      // form module for one would import names the validation output never wrote.
      const usable = table.readOnly ? modes.filter((m) => m === 'select') : modes;
      if (!usable.length) continue;

      const stem = `${table.tsName}.form`;
      const filePath = path.join(out, `${stem}.ts`);
      const code = renderTable(table, usable, {
        spec,
        affix,
        resolver,
        wantsResolver,
        wantsFormOptions,
      });
      const formatted = await formatCode(withHeader(code, opts.outputHeader), filePath, opts.format);
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
      written.push({ stem });
      opts.onProgress?.({ index, total: tables.length, table: table.name, filePath });
    }

    if (!written.length) {
      throw new Error(
        '@drzl/generator-forms: no table produced a form module. A schema with no table, or one ' +
          'whose every table is read-only with `modes` naming only writes, produces this.'
      );
    }

    const barrelPath = path.join(out, `${FORMS_MODULE}.ts`);
    const barrel = written
      .map((w) => `export * from ${JSON.stringify(importSpecifier(`./${w.stem}.ts`, opts.importExtension))};`)
      .join('\n');
    const formattedBarrel = await formatCode(
      withHeader(`${barrel}\n`, opts.outputHeader),
      barrelPath,
      opts.format
    );
    await fs.writeFile(barrelPath, formattedBarrel, 'utf8');
    files.push(barrelPath);

    return { files };
  }
}

function renderTable(
  table: Table,
  modes: Mode[],
  ctx: {
    spec: string;
    affix: ReturnType<typeof resolveAffix>;
    resolver: { specifier: string; fn: string };
    wantsResolver: boolean;
    wantsFormOptions: boolean;
  }
): string {
  const { spec, affix, resolver, wantsResolver, wantsFormOptions } = ctx;
  const T = pascal(table.tsName);
  const schemas = modes.map((m) => ({ mode: m, local: schemaName(m, table.tsName, affix) }));

  const out: string[] = [];
  if (wantsResolver) {
    out.push(`import { ${resolver.fn} } from ${JSON.stringify(resolver.specifier)};`);
  }
  out.push(`import { ${schemas.map((s) => s.local).join(', ')} } from ${JSON.stringify(spec)};`);
  out.push('');

  out.push(
    '/**',
    ` * What each ${table.name} column is, in the terms a form control needs.`,
    ' *',
    ' * The bounds are the ones the database really enforces: a CHECK on the column narrows the',
    " * type's own range, and the same fold produced the bounds in the schemas beside this file.",
    ' * `min` and `max` are text, because a 64 bit bound is not representable as a JS number.',
    ' */',
    `export const ${table.tsName}Fields = {`,
    fieldFacts(table)
      .map((f) => renderField(f, '  '))
      .join('\n'),
    '} as const;',
    ''
  );

  for (const { mode, local } of schemas) {
    const M = pascal(mode);
    if (wantsResolver) {
      out.push(
        `/** A react-hook-form resolver for the ${mode} schema. */`,
        `export const ${table.tsName}${M}Resolver = ${resolver.fn}(${local});`,
        ''
      );
    }
    if (wantsFormOptions) {
      out.push(
        '/**',
        ` * TanStack Form options for the ${mode} schema.`,
        ' *',
        ' * The schema goes in directly: TanStack Form takes any Standard Schema and needs no',
        ' * resolver. Validation runs on change, which is when a form drives it.',
        ' */',
        `export const ${table.tsName}${M}FormOptions = {`,
        `  validators: { onChange: ${local} },`,
        '} as const;',
        ''
      );
    }
  }

  void T;
  return out.join('\n');
}

/** The header, in the shape every other generator writes it. */
function withHeader(code: string, header: GenerateOptions['outputHeader']): string {
  if (header && header.enabled === false) return code;
  const text = header?.text?.trim();
  const lines = text
    ? text.split(/\r?\n/).map((l) => `// ${l}`)
    : [
        '// Generated by DRZL (@drzl/*)',
        "// Generated output is granted to you under your project's license.",
        '// You may use, copy, modify, and distribute without attribution.',
      ];
  return `${lines.join('\n')}\n\n${code}`;
}
