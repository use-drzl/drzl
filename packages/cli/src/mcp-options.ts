/**
 * The options `@drzl/generator-mcp` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch
 * in both used to assemble its own options object by hand. Four documented options have already
 * been found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/mcp-branch-parity.spec.ts` for this one.
 *
 * There is no `databaseInjection` here, for the reason the config parser reports rather than
 * silently honours: the emitted tool handlers are stubs, so nothing would read an injected handle.
 * `includeRelations` is absent too, since a relation lookup is a route and this generator emits
 * tools rather than routes.
 */
import { mcpOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  sdk?: unknown;
  serverName?: unknown;
  serverVersion?: unknown;
  stdio?: unknown;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
};

export function mcpOptions(g: GeneratorConfig, cfg: { outDir: string }): Record<string, unknown> {
  return {
    outputDir: mcpOutDir(g, cfg),
    sdk: g.sdk,
    serverName: g.serverName,
    serverVersion: g.serverVersion,
    stdio: g.stdio,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
  };
}
