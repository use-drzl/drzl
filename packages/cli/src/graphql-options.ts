/**
 * The options `@drzl/generator-graphql` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Four documented options have already
 * been found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/graphql-branch-parity.spec.ts` for this one.
 *
 * There is no `includeRelations` here, unlike the router builders: relation fields on a GraphQL
 * type are resolvers the consumer writes, not routes this generator emits. There is no
 * `servicesDir` and no `databaseInjection` either, for the stronger form of the same reason:
 * the emitted resolvers are stubs. And there is no `validation` at all, unlike every kind that
 * takes one: the emitted schema is GraphQL SDL, GraphQL's own type language, so there is no
 * library to choose, and `resolveConfig` warns about the whole block on this kind.
 */
import { graphqlOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
};

export function graphqlOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: graphqlOutDir(g, cfg),
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
  };
}
