/**
 * The options `@drzl/generator-json-schema` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and the json-schema
 * branch was assembled by hand in both. That arrangement has already dropped options silently more
 * than once here: five validation options never reached a watch rebuild, and `watch` had no
 * json-schema branch at all for a while, so that directory went stale from the first save onward.
 * None of it is visible in the wiring, because the option parses, the generator defaults it, and
 * the feature simply does nothing.
 *
 * One builder makes the two call sites the same object by construction rather than by review, and
 * `packages/cli/test/openapi-branch-parity.e2e.spec.ts` runs both commands and compares the bytes.
 */
import { validationOptions, type ValidationGeneratorConfig } from './validation-options.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = ValidationGeneratorConfig & {
  path?: string;
  target?: unknown;
  components?: unknown;
  document?: unknown;
  includeRelations?: unknown;
};

export function jsonSchemaOptions(
  g: GeneratorConfig,
  cfg: { schema?: unknown },
  outDir: string
): Record<string, unknown> {
  return {
    // JSON Schema is data, so nothing it emits references a type from the schema module.
    ...validationOptions(g, cfg, outDir, { schemaTypes: false }),
    target: g.target,
    components: g.components,
    document: g.document,
    // Read only while emitting a document, where it adds `/users/{id}/posts`. The per-table
    // schemas are flat whatever it says.
    includeRelations: g.includeRelations,
  };
}
