/**
 * The options `@drzl/generator-service` receives, built in one place.
 *
 * Assembled by hand in both dispatch loops until now, and one of them was already missing a key:
 * `databaseInjection` is what gives a generated service a `db` parameter, and a router generated
 * in injection mode calls `Service.getById(ctx.db, id)`. The two halves of one generated project
 * therefore disagreed about the signature whenever the option was set.
 *
 * `outDir`, not `outputDir`. This generator spells it the short way and the routers spell it the
 * long way, which is a difference in their published option types rather than a choice this file
 * gets to make.
 */
import type { ValidationGeneratorConfig } from './validation-options.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = Pick<ValidationGeneratorConfig, 'outputHeader' | 'format'> & {
  dataAccess?: unknown;
  dbImportPath?: unknown;
  schemaImportPath?: unknown;
  importExtension?: unknown;
  databaseInjection?: unknown;
};

export function serviceOptions(g: GeneratorConfig, outDir: string): Record<string, unknown> {
  return {
    outDir,
    outputHeader: g.outputHeader,
    format: g.format,
    dataAccess: g.dataAccess,
    dbImportPath: g.dbImportPath,
    schemaImportPath: g.schemaImportPath,
    importExtension: g.importExtension,
    databaseInjection: g.databaseInjection,
  };
}
