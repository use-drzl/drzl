/**
 * The options every validation generator receives, built in one place.
 *
 * Each generator branch used to assemble this by hand, and three documented options were
 * found silently dead as a result: `typedJson` never reached typebox, and `coerceDates` and
 * `applyDefaults` never reached anything but zod. The config parsed them, the CLI dropped them,
 * and the feature simply did nothing while nothing said so. Building it once removes the class
 * rather than fixing each instance.
 *
 * What stays per-generator is a real capability rather than an oversight, which is why it is
 * named as one.
 */

/**
 * A generator entry from the config, loosely typed because the config schema owns its shape.
 *
 * Exported so a builder that wraps this one names the same keys rather than restating them: every
 * key listed in two places is a key the two can drift on, which is the failure this file exists to
 * remove.
 */
export type ValidationGeneratorConfig = {
  outputHeader?: unknown;
  format?: unknown;
  schemaSuffix?: unknown;
  fileSuffix?: unknown;
  importExtension?: unknown;
  affix?: unknown;
  coerceDates?: unknown;
  applyDefaults?: unknown;
  typedJson?: unknown;
  typedColumns?: unknown;
  duplicateFinder?: unknown;
  nestedSchemas?: unknown;
  nestedDepth?: unknown;
};

export interface GeneratorCapabilities {
  /**
   * Whether the generator can reference a type from the schema module.
   *
   * `typedJson` and `typedColumns` both work by importing the table back and reading
   * `typeof table.$inferSelect['col']`, so a generator that cannot embed a TypeScript type in its
   * output cannot use either. ArkType is the case: it emits one string per field, and a type
   * reference has nowhere to live inside a string DSL.
   */
  schemaTypes?: boolean;
}

export function validationOptions(
  g: ValidationGeneratorConfig,
  cfg: { schema?: unknown },
  outDir: string,
  caps: GeneratorCapabilities = {}
): Record<string, unknown> {
  return {
    outDir,
    outputHeader: g.outputHeader,
    format: g.format,
    schemaSuffix: g.schemaSuffix,
    fileSuffix: g.fileSuffix,
    importExtension: g.importExtension,
    affix: g.affix,
    coerceDates: g.coerceDates,
    applyDefaults: g.applyDefaults,
    duplicateFinder: g.duplicateFinder,
    nestedSchemas: g.nestedSchemas,
    nestedDepth: g.nestedDepth,
    // Only where the generator can act on them, so an unsupported option is absent rather than
    // present and ignored.
    ...(caps.schemaTypes
      ? {
          // Needed by both: the reference is resolved relative to the emitted file.
          schemaPath: cfg.schema,
          typedJson: g.typedJson,
          typedColumns: g.typedColumns,
        }
      : {}),
  };
}
