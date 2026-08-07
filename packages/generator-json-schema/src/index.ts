/**
 * JSON Schema and OpenAPI documents from a Drizzle schema.
 *
 * The other four generators each target one validation library, which means the output is only
 * useful to a TypeScript program that installs that library. JSON Schema is the format everything
 * else already reads: OpenAPI documents, API gateways, form builders, contract tests, and
 * validators in other languages. Nothing in the official Drizzle family emits it.
 *
 * There is no runtime dependency here, not even an optional one. The output is data.
 *
 * Three things can be emitted, each independent of the others:
 *
 *   per table    one module of insert/update/select schemas, always
 *   components   `components.schemas` for an OpenAPI document, on `components: true`
 *   document     the whole OpenAPI document, paths and all, on `document: true`
 */
import type { Analysis, Table } from '@drzl/analyzer';
import type { ResolvedAffix, ValidationGenerateOptions } from '@drzl/validation-core';
import {
  formatCode,
  moduleFileName,
  moduleSpecifier,
  resolveAffix,
  schemaName,
  typeName,
} from '@drzl/validation-core';
import {
  openApiDocument,
  type OpenApiDocumentOptions,
  type OpenApiInfo,
  type OpenApiServer,
} from './openapi.js';
import { componentsDocument, tableSchemas, type JsonSchemaTarget, type Mode } from './schemas.js';

export * from './schemas.js';
export * from './openapi.js';

const DEFAULT_FILE_SUFFIX = '.schema.ts';

function renderTableModule(
  table: Table,
  affix: ResolvedAffix,
  target: JsonSchemaTarget,
  applyDefaults: boolean
): string {
  const T = table.tsName;
  const schemas = tableSchemas(table, { target, applyDefaults });
  const decl = (mode: Mode) =>
    `export const ${schemaName(mode, T, affix)} = ${JSON.stringify(schemas[mode], null, 2)} as const;

export type ${typeName(mode, T, affix)} = typeof ${schemaName(mode, T, affix)};`;
  return [decl('insert'), decl('update'), decl('select')].join('\n\n') + '\n';
}

/**
 * How the OpenAPI document is asked for, and what goes in the parts of it a schema cannot supply.
 *
 * `true` is the short form, matching `components: true`. The object form is for the fields DRZL
 * genuinely does not know: a Drizzle schema says nothing about what the API is called, where it is
 * served, or which status code that particular server answers a bad body with.
 */
export interface OpenApiDocumentEmitOptions {
  /** Default `true` once the object is present, so `{ enabled: false }` turns it off in place. */
  enabled?: boolean;
  /**
   * Which files to write.
   *
   * `ts` by default, because everything else this generator emits is a module: it is what a server
   * imports to serve its own document, and it is typechecked along with the rest of the output.
   * `json` is the file Swagger UI, a linter or a client generator reads directly. No YAML: it would
   * need a dependency, and this package deliberately has none.
   */
  format?: 'ts' | 'json' | 'both';
  info?: OpenApiInfo;
  servers?: OpenApiServer[];
  validationStatus?: 400 | 422;
}

export interface JsonSchemaGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
  target?: JsonSchemaTarget;
  /**
   * Also emit `components.ts`, one object keyed by name and ready to spread into an OpenAPI
   * document's `components.schemas`.
   *
   * Off by default, so nobody who wanted per-table modules gets a file they did not ask for.
   */
  components?: boolean;
  /**
   * Also emit the whole OpenAPI document: paths, verbs, request and response bodies per table, with
   * `components.schemas` embedded so the file stands alone.
   *
   * Off by default, for the same reason.
   */
  document?: boolean | OpenApiDocumentEmitOptions;
  /**
   * Emit `/users/{id}/posts` for a child that names its parent by foreign key. Only read when a
   * document is being emitted; the per-table schemas are flat whatever this says.
   */
  includeRelations?: boolean;
}

/** `document: true`, `document: {...}` and `document: false` as one shape, or `null` for off. */
function resolveDocument(
  opt: JsonSchemaGenerateOptions['document']
): (OpenApiDocumentEmitOptions & { format: 'ts' | 'json' | 'both' }) | null {
  if (!opt) return null;
  const o = opt === true ? {} : opt;
  if (o.enabled === false) return null;
  return { ...o, format: o.format ?? 'ts' };
}

export class JsonSchemaGenerator {
  readonly library = 'json-schema' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: JsonSchemaGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const target = opts.target ?? 'draft-2020-12';
    const document = resolveDocument(opts.document);

    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableModule(table, affix, target, !!opts.applyDefaults);
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    }

    if (opts.components) {
      const doc = componentsDocument(this.analysis.tables, {
        target,
        applyDefaults: !!opts.applyDefaults,
      });
      const componentsPath = path.join(out, 'components.ts');
      const code = `export const components = ${JSON.stringify(doc, null, 2)} as const;\n`;
      await fs.writeFile(
        componentsPath,
        await formatCode(buildHeader(opts.outputHeader) + code, componentsPath, opts.format),
        'utf8'
      );
      files.push(componentsPath);
    }

    if (document) {
      const built = openApiDocument(this.analysis.tables, {
        target,
        applyDefaults: !!opts.applyDefaults,
        includeRelations: !!opts.includeRelations,
        info: document.info,
        servers: document.servers,
        validationStatus: document.validationStatus,
      } satisfies OpenApiDocumentOptions);
      const body = JSON.stringify(built, null, 2);
      if (document.format !== 'json') {
        const tsPath = path.join(out, 'openapi.ts');
        const code = `export const openapi = ${body} as const;\n`;
        await fs.writeFile(
          tsPath,
          await formatCode(buildHeader(opts.outputHeader) + code, tsPath, opts.format),
          'utf8'
        );
        files.push(tsPath);
      }
      if (document.format !== 'ts') {
        // No header comment: JSON has no comments, and a `x-generated-by` key would be a member of
        // the document rather than a note about the file.
        const jsonPath = path.join(out, 'openapi.json');
        await fs.writeFile(jsonPath, body + '\n', 'utf8');
        files.push(jsonPath);
      }
    }

    const ext = opts.importExtension === 'none' ? '' : '.js';
    const indexPath = path.join(out, 'index.ts');
    const index =
      this.analysis.tables
        .map(
          (t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`
        )
        .concat(opts.components ? [`export * from './components${ext}';`] : [])
        // Only the module form. `openapi.json` is data a server reads, not something a barrel of
        // TypeScript modules can re-export.
        .concat(document && document.format !== 'json' ? [`export * from './openapi${ext}';`] : [])
        .join('\n') + '\n';
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + index,
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: JsonSchemaGenerateOptions) {
    return renderTableModule(
      table,
      resolveAffix(opts),
      opts?.target ?? 'draft-2020-12',
      !!opts?.applyDefaults
    );
  }
}

export default JsonSchemaGenerator;

function buildHeader(h?: { enabled?: boolean; text?: string }) {
  if (h?.enabled === false) return '';
  const text = h?.text ?? '// Generated by DRZL. Do not edit by hand.';
  return `${text}\n\n`;
}
