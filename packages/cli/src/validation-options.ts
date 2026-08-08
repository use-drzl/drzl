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
  constraints?: unknown;
  nestedSchemas?: unknown;
  nestedDepth?: unknown;
  branded?: unknown;
  standardSchema?: unknown;
  meta?: unknown;
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
  /**
   * Whether the generator has a `~standard` key to add.
   *
   * TypeBox is the only one that has: zod, valibot and arktype put one on every schema they build,
   * measured on 4.4.3, 1.4.2 and 2.2.3, so there is nothing for the option to do there and setting
   * it would read as a promise that something changed.
   */
  standardSchema?: boolean;
  /**
   * Whether the generator can attach metadata to what it emits.
   *
   * zod is the only one so far, and deliberately: it is the one validator here whose metadata has
   * a destination outside itself, since `z.toJSONSchema` copies arbitrary keys through into the
   * document an OpenAPI consumer reads. The other four each have a facility of their own and each
   * needs its own measurement of where the metadata has to attach, which is the whole difficulty;
   * building four on the strength of one measurement is how three of them come to be subtly wrong.
   */
  meta?: boolean;
  /**
   * Whether the generator emits the constraint ledger beside its schemas.
   *
   * zod and valibot so far, and the boundary is measured rather than conservative. The ledger
   * carries the exact message the emitted schema attaches for each constraint, which is what the
   * error map keys on, and those two enforce the same set of constraints in the same words.
   *
   * ArkType is the case that says why this is a flag. Measured on 2.2.3 against the same table:
   * it folds `cardinality(tags) > 0` into its own DSL, moves a `length()` check onto the object
   * so the issue names no column, reports DRZL's wording in `expected` rather than in `message`,
   * and emits nothing at all for `name <> 'x'`. A ledger claiming that constraint is enforced
   * would be wrong there, and it would be wrong silently.
   */
  constraints?: boolean;
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
    // Every validation generator can express a brand, including TypeBox, which has no brand
    // helper and gets one from `TUnsafe` instead. So this needs no capability flag: an option
    // that reached only four of the five would be the class of defect this file exists to
    // remove.
    branded: g.branded,
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
    ...(caps.standardSchema ? { standardSchema: g.standardSchema } : {}),
    ...(caps.meta ? { meta: g.meta } : {}),
    ...(caps.constraints ? { constraints: g.constraints } : {}),
  };
}
