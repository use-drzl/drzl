/**
 * The options `@drzl/generator-express` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Four documented options have already
 * been found dead that way, which is why every router branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/express-branch-parity.spec.ts` for this one.
 *
 * There is no `validator` here, unlike `honoOptions`, because the Express generator has exactly
 * one middleware and emits it: Express has no official validator packages for a config to choose
 * between. There is no `servicesDir` and no `databaseInjection` either, deliberately: this
 * generator emits stub handlers and never calls a service, so passing either would be wiring an
 * option nothing reads. `resolveConfig` warns when a config sets `databaseInjection` on this
 * generator for the same reason.
 */
import { expressOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  includeRelations?: unknown;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
};

export function expressOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: expressOutDir(g, cfg),
    includeRelations: g.includeRelations,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
  };
}
