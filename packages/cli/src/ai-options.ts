/**
 * The options `@drzl/generator-ai` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/ai-branch-parity.spec.ts` for this one.
 *
 * There is no `includeRelations` and no `databaseInjection` here, for the reasons the config parser
 * reports rather than silently honours: a relation lookup is a route and this generator emits
 * tools, and the emitted `execute` bodies are stubs that read no injected handle.
 */
import { aiOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  validation?: unknown;
};

export function aiOptions(g: GeneratorConfig, cfg: { outDir: string }): Record<string, unknown> {
  return {
    outputDir: aiOutDir(g, cfg),
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: g.validation,
  };
}
