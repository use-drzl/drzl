/**
 * The options `@drzl/generator-hono` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Three documented options have already
 * been found dead that way: `typedJson` never reached typebox, `coerceDates` and `applyDefaults`
 * reached nothing but zod, and `servicesDir` was passed by `generate`'s oRPC branch and not by
 * `watch`'s, so a watch rebuild emitted a service import pointing at the default directory
 * whatever the config said. None of those is visible in the wiring: the option parses, the
 * generator defaults it, and the feature simply does nothing.
 *
 * One builder means the two call sites are the same object by construction rather than by review.
 * It also gives the drift something to be asserted against, which is what
 * `packages/cli/test/hono-branch-parity.spec.ts` does by running both commands and comparing the
 * bytes they wrote.
 *
 * There is no `servicesDir` and no `databaseInjection` here, and their absence is deliberate
 * rather than an omission: this generator emits stub handlers and never calls a service, so
 * passing either would be wiring an option nothing reads. `resolveConfig` warns when a config
 * sets `databaseInjection` on this generator for the same reason.
 */
import { honoOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  includeRelations?: unknown;
  naming?: unknown;
  validator?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
};

export function honoOptions(g: GeneratorConfig, cfg: { outDir: string }): Record<string, unknown> {
  return {
    outputDir: honoOutDir(g, cfg),
    includeRelations: g.includeRelations,
    naming: g.naming,
    validator: g.validator,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
  };
}
