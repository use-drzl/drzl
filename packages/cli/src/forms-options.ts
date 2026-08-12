/**
 * The options `@drzl/generator-forms` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/forms-branch-parity.spec.ts` for this one.
 *
 * A single mode rather than two, like the `ts-rest` and `openapi-fetch` builders: a resolver with no
 * schema is nothing, so `useShared` is not a choice and the import path is derived from the sibling
 * validation entry's own `path`.
 *
 * Unlike those two, `library` is **not** narrowed to zod here. Every library DRZL emits has a
 * react-hook-form resolver: three share `standardSchemaResolver` and TypeBox and Effect have their
 * own in the same package. Rewriting `typebox` to `zod` would emit a resolver for a schema module
 * the project does not have.
 */
import { formsOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  target?: string;
  modes?: unknown;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype' | 'typebox' | 'effect';
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
  typebox: 'src/validators/typebox',
  effect: 'src/validators/effect',
};

/**
 * A generator's own `path`, spelled the way `validation.importPath` is read.
 *
 * A `path` is project-relative; an `importPath` beginning with `./` is relative to the *output*
 * directory. Copying one into the other resolves to nothing.
 */
function projectRelative(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export function formsOptions(
  g: GeneratorConfig,
  cfg: { outDir: string; generators: ReadonlyArray<{ kind: string; path?: string }> }
): Record<string, unknown> {
  const library = g.validation?.library ?? 'zod';
  // Exactly one sibling, or none: two generators of the same kind mean there is no single source of
  // truth, and the generator's own error is a better answer than picking one of them here.
  const siblings = cfg.generators.filter((s) => s.kind === library);
  const derived =
    siblings.length === 1
      ? projectRelative(siblings[0].path ?? VALIDATOR_DEFAULT_DIRS[library])
      : undefined;

  return {
    outputDir: formsOutDir(g, cfg),
    target: g.target,
    modes: g.modes,
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
