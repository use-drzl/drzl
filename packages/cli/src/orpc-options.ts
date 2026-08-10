/**
 * The options `@drzl/generator-orpc` receives, built in one place.
 *
 * The last kind to get one. `generate` and `watch` each assembled this object by hand, and the
 * two copies agreed only because somebody kept checking: `servicesDir` reached the tRPC branch of
 * one command and not the other for a whole release, which is the same shape of defect one file
 * along. The builders for the other thirteen kinds exist for that reason and this one completes
 * the set, so the registry can hand every generator its options the same way.
 *
 * `outputDir` is `cfg.outDir` and never `g.path`, which is oRPC's own arrangement rather than an
 * omission: this generator has always written where the top-level setting says, and
 * `computeGeneratorOutputDirs` adds `cfg.outDir` unconditionally for it. A `path` on an oRPC entry
 * is ignored, as it always has been, and moving it now would relocate the output of every existing
 * config that happens to set one.
 */

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  template?: unknown;
  includeRelations?: unknown;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  templateOptions?: unknown;
  importExtension?: unknown;
  validation?: unknown;
  databaseInjection?: unknown;
};

export function orpcOptions(
  g: GeneratorConfig,
  cfg: { outDir: string },
  servicesDir: string
): Record<string, unknown> {
  return {
    outputDir: cfg.outDir,
    template: g.template,
    includeRelations: g.includeRelations,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    templateOptions: g.templateOptions,
    importExtension: g.importExtension,
    validation: g.validation,
    // Documented on this generator since it was added and unreachable from a config file for most
    // of that time, because the config schema had no such key and zod stripped it in silence.
    databaseInjection: g.databaseInjection,
    // Where the service generator is actually writing, so a router template that imports services
    // spells a path that exists. The templates default this to `src/services`, which is right only
    // by coincidence for a config that puts them elsewhere.
    servicesDir,
  };
}
