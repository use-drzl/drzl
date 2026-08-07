/**
 * The options `@drzl/generator-trpc` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both assembles its own options object by hand. Three documented options have already been
 * found dead that way: `typedJson` never reached typebox, `coerceDates` and `applyDefaults`
 * reached nothing but zod, and `servicesDir` is passed by `generate`'s oRPC branch and not by
 * `watch`'s, so a watch rebuild emits a service import pointing at the default directory whatever
 * the config says. None of those is visible in the wiring: the option parses, the generator
 * defaults it, and the feature simply does nothing.
 *
 * One builder means the two call sites are the same object by construction rather than by review.
 * It also gives the drift something to be asserted against, which is what
 * `packages/cli/test/trpc-branch-parity.spec.ts` does by running both commands and comparing the
 * bytes they wrote.
 */
import { trpcOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  template?: unknown;
  includeRelations?: unknown;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
  databaseInjection?: unknown;
};

export function trpcOptions(
  g: GeneratorConfig,
  cfg: { outDir: string },
  servicesDir: string
): Record<string, unknown> {
  return {
    outputDir: trpcOutDir(g, cfg),
    template: g.template,
    includeRelations: g.includeRelations,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
    databaseInjection: g.databaseInjection,
    // Where the service generator is actually writing, so `template: 'service'` emits an import
    // of a module that exists. The generator defaults this to `src/services`, which is right only
    // by coincidence for a config that puts them elsewhere.
    servicesDir,
  };
}
