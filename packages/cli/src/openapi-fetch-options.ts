/**
 * The options `@drzl/generator-openapi-fetch` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/openapi-fetch-branch-parity.spec.ts` for this one.
 *
 * Like the `ts-rest` builder, this has a single mode rather than two. A client is nothing but its
 * types, so `useShared` is not a choice, and the import path is derived from the sibling validation
 * generator's own `path` rather than left for the user to repeat.
 *
 * **The `document` option is forwarded rather than derived.** Whatever is passed to the
 * `json-schema` generator's `document` belongs here too, and the two are not checked against each
 * other because they run as separate generators. Deriving one from the other is tempting and would
 * be wrong in a way nothing reports: a config naming no `json-schema` generator at all is legal,
 * and the client still has to describe an API.
 */
import { openApiFetchOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  clientName?: string;
  document?: unknown;
  validation?: {
    useShared?: boolean;
    /** Widened to the config's own union, for the reason the ts-rest builder records. */
    library?: 'zod' | 'valibot' | 'arktype' | 'typebox';
    importPath?: string;
    schemaSuffix?: string;
    affix?: unknown;
  };
};

/** Where each validation generator writes when its entry names no `path`, repeated from the registry. */
const VALIDATOR_DEFAULT_DIRS: Record<string, string> = {
  zod: 'src/validators/zod',
  valibot: 'src/validators/valibot',
  arktype: 'src/validators/arktype',
};

/**
 * A generator's own `path`, spelled the way `validation.importPath` is read.
 *
 * A `path` is always relative to the project; an `importPath` beginning with `./` is relative to the
 * *output* directory. Copying one into the other resolves to nothing, which is the trap every
 * options builder in this package now has this helper to avoid.
 */
function projectRelative(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export function openApiFetchOptions(
  g: GeneratorConfig,
  cfg: { outDir: string; generators: ReadonlyArray<{ kind: string; path?: string }> }
): Record<string, unknown> {
  const configured = g.validation?.library ?? 'zod';
  const library = configured === 'typebox' ? 'zod' : configured;
  // Exactly one sibling, or none: two generators of the same kind mean there is no single source of
  // truth, and the generator's own error is a better answer than picking one of them here.
  const siblings = cfg.generators.filter((s) => s.kind === library);
  const derived =
    siblings.length === 1
      ? projectRelative(siblings[0].path ?? VALIDATOR_DEFAULT_DIRS[library])
      : undefined;

  return {
    outputDir: openApiFetchOutDir(g, cfg),
    clientName: g.clientName,
    document: g.document,
    outputHeader: g.outputHeader,
    format: g.format,
    importExtension: g.importExtension,
    validation: {
      ...g.validation,
      library,
      useShared: true,
      importPath: g.validation?.importPath ?? derived,
    },
  };
}
