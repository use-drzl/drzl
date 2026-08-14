/**
 * The options `@drzl/generator-pothos` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have been found
 * dead that way, which is why every generator branch calls a shared builder and a branch-parity
 * spec compares the bytes the two commands write.
 *
 * Short, like the seed and fast-check builders and for the same reason: this generator reads
 * nothing from a validation generator. A Pothos object type is checked against the row interface
 * this generator writes itself, so there is no `validation` block to forward.
 */
import { pothosOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
};

export function pothosOptions(
  g: GeneratorConfig,
  cfg: { outDir: string }
): Record<string, unknown> {
  return {
    outputDir: pothosOutDir(g, cfg),
    naming: g.naming,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
  };
}
