/**
 * The options `@drzl/generator-fastify` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Four documented options have already
 * been found dead that way, which is why every router branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/fastify-branch-parity.spec.ts` for this one.
 *
 * There is no `validation` here, unlike the hono and express builders, because the Fastify
 * generator has no validation library to choose and no shared schema module to import: its route
 * schemas are JSON Schema produced by the same builder as the `json-schema` generator and
 * inlined into the routes, and Fastify's own AJV is the validator. `resolveConfig` warns when a
 * config sets `validation` on this generator for the same reason. There is no `servicesDir` and
 * no `databaseInjection` either, deliberately: this generator emits stub handlers and never
 * calls a service, so passing either would be wiring an option nothing reads, and `resolveConfig`
 * warns about `databaseInjection` too.
 */
import { fastifyOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  includeRelations?: unknown;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
};

export function fastifyOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: fastifyOutDir(g, cfg),
    includeRelations: g.includeRelations,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
  };
}
