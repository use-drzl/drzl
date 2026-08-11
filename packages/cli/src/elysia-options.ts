/**
 * The options `@drzl/generator-elysia` receives, built in one place.
 *
 * `generate` and `watch` each dispatch over `cfg.generators` in their own loop, and every branch in
 * both used to assemble its own options object by hand. Four documented options have already been
 * found dead that way, which is why every generator branch now calls a shared builder and a
 * branch-parity spec compares the bytes the two commands write:
 * `packages/cli/test/elysia-branch-parity.spec.ts` for this one.
 *
 * Like the `h3`, `next`, `tanstack-start` and `ts-rest` builders, this one has a single mode rather
 * than two: the generator emits no schemas of its own, so `useShared` is not a choice and the import
 * path is derived from the sibling validation generator's own `path`.
 *
 * It defaults to zod like every other router, and TypeBox is worth a note rather than the default.
 * Elysia's own `t` *is* TypeBox and this is the only kind whose validator slot accepts a TypeBox
 * schema, so a Bun project probably wants it. But TypeBox ships separate `.d.ts` and `.d.mts`
 * declarations whose types are branded with distinct `unique symbol`s, and Elysia's own types are
 * declared as CommonJS, so under `moduleResolution: node16` or `nodenext` the two resolve to
 * different copies and a TypeBox schema is not assignable to Elysia's slot. Measured against
 * elysia@1.4.29 and @sinclair/typebox@0.34.52. It compiles cleanly under `bundler`, which is what
 * Bun projects use, so the option is worth having and the default is not.
 */
import { elysiaOutDir } from './config.js';

/** A generator entry from the config, loosely typed because the config schema owns its shape. */
type GeneratorConfig = {
  path?: string;
  naming?: unknown;
  outputHeader?: unknown;
  format?: unknown;
  importExtension?: unknown;
  appName?: string;
  prefix?: string;
  validation?: {
    useShared?: boolean;
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
  typebox: 'src/validators/typebox',
};

/**
 * A generator's own `path`, spelled the way `validation.importPath` is read.
 *
 * The two look identical and are resolved against different roots. A `path` is always relative to
 * the project, which is why every generator does `path.resolve(process.cwd(), opts.outputDir)`. An
 * `importPath` beginning with `./` is deliberately relative to the *output* directory instead, so
 * a project that keeps its schemas beside its routes can say `./schemas` and mean it.
 *
 * So a `path` of `./out/schemas` copied straight across becomes `out/routes/out/schemas`, which
 * resolves to nothing. Stripping the prefix is what makes the derived value mean what the sibling
 * entry said. Measured on the MCP generator through the packed gate, and again since.
 */
function projectRelative(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export function elysiaOptions(
  g: GeneratorConfig,
  cfg: { outDir: string; generators: ReadonlyArray<{ kind: string; path?: string }> }
): Record<string, unknown> {
  const library = g.validation?.library ?? 'zod';
  // The sibling that writes the schemas these routes validate with. Exactly one, or none: two
  // generators of the same kind mean there is no single source of truth, and the generator's own
  // error is a better answer than picking one of them here.
  const siblings = cfg.generators.filter((s) => s.kind === library);
  const derived =
    siblings.length === 1
      ? projectRelative(siblings[0].path ?? VALIDATOR_DEFAULT_DIRS[library])
      : undefined;

  return {
    outputDir: elysiaOutDir(g, cfg),
    appName: g.appName,
    prefix: g.prefix,
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
