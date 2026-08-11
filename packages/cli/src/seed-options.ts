/**
 * The options `@drzl/generator-seed` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/seed-branch-parity.spec.ts` for this one.
 *
 * The shortest builder here, and for a real reason rather than an omission: this generator reads
 * nothing from a validation generator. Its constraints come from the analysis directly, so there is
 * no `validation` block to forward and no sibling to derive an import path from.
 */
import { seedOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  count?: number;
};

export function seedOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: seedOutDir(g, cfg),
    defaultCount: g.count,
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
  };
}
