/**
 * The options `@drzl/generator-h3` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/h3-branch-parity.spec.ts` for this one.
 *
 * This builder does one thing none of the others do, and the reason is that this generator has one
 * mode rather than two. It emits no schemas of its own: its route handlers validate with the constrained schemas a
 * validation generator wrote, which is where the CHECK bounds a caller is held to come from. So
 * `useShared` is not a choice here, and the import path is derived from the sibling generator's own
 * `path` rather than left for the user to repeat. A config that names both generators and nothing
 * else is therefore complete, and a config that points somewhere specific still wins.
 */
import { h3OutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  h3?: unknown;
  validation?: {
    useShared?: boolean;
    /**
     * Widened to the config's own union rather than to what this generator supports.
     *
     * `validation.library` accepts `typebox` because the `elysia` generator can use it: Elysia's
     * validator slot takes a TypeBox schema natively. No other router can, and the config parser
     * reports naming it on one of them. This builder therefore falls back rather than passing a
     * value the generator has no dialect for, which would otherwise reach a `LIBS[lib]` lookup and
     * come back undefined.
     */
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
 * The two look identical and are resolved against different roots. A `path` is always relative to
 * the project, which is why every generator does `path.resolve(process.cwd(), opts.outputDir)`. An
 * `importPath` beginning with `./` is deliberately relative to the *output* directory instead, so
 * a project that keeps its schemas beside its actions can say `./schemas` and mean it.
 *
 * So a `path` of `./out/schemas` copied straight across becomes `out/next/out/schemas`, which
 * resolves to nothing. Stripping the prefix is what makes the derived value mean what the sibling
 * entry said. Measured twice: once through the packed gate on the MCP generator, once here.
 */
function projectRelative(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export function h3Options(
  g: GeneratorConfig,
  cfg: { outDir: string; generators: ReadonlyArray<{ kind: string; path?: string }> }
): Record<string, unknown> {
  // `typebox` is accepted by the config for the `elysia` generator alone, and the parser reports
  // it on any other kind. Falling back keeps the emitted output valid for a config that ignored
  // that warning, rather than looking up a dialect that does not exist.
  const configured = g.validation?.library ?? 'zod';
  const library = configured === 'typebox' ? 'zod' : configured;
  // The sibling that writes the schemas these actions parse. Exactly one, or none: two generators
  // of the same kind mean there is no single source of truth, and the generator's own error is a
  // better answer than picking one of them here.
  const siblings = cfg.generators.filter((s) => s.kind === library);
  const derived =
    siblings.length === 1
      ? projectRelative(siblings[0].path ?? VALIDATOR_DEFAULT_DIRS[library])
      : undefined;

  return {
    outputDir: h3OutDir(g, cfg),
    h3: g.h3,
    naming: g.naming,
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
