/**
 * The options `@drzl/generator-nestjs` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Four documented options have already
 * been found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/nestjs-branch-parity.spec.ts` for this one.
 *
 * There is no `includeRelations` here, unlike the router builders: relation lookups are routes,
 * and this generator emits DTO classes rather than routes, so the flag would be wiring an option
 * nothing reads. There is no `servicesDir` and no `databaseInjection` either, for the stronger
 * form of the same reason: there are no handlers at all. `validation` is forwarded whole; the
 * generator reads `library` and `resolveConfig` warns about every other key on this kind.
 */
import { nestjsOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
};

export function nestjsOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: nestjsOutDir(g, cfg),
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
  };
}
