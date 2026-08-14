/**
 * Every generator DRZL can run, as data rather than as control flow.
 *
 * The same fourteen-way dispatch was written out four times: once inside `generate`, once inside
 * `watch`, and once each in `generate:orpc` and `generate:trpc`. Every copy repeated the package
 * name, the `import()`, the constructor, the default output directory and the call to the options
 * builder, and the copies were kept in step by review alone. Review is measurably not enough for
 * this: `servicesDir` reached one loop's tRPC branch and not the other's for a release,
 * five validation options never reached a watch rebuild at all, and `watch` had no json-schema
 * branch for a while, so that directory went stale from the first save onward. None of it was
 * visible in the wiring, because a dropped option parses, the generator defaults it, and the
 * feature silently does nothing.
 *
 * So each generator states those five facts once, here, and the commands loop over this list. A
 * new generator is one entry: adding it to the config enum and forgetting a dispatch branch is no
 * longer a state the code can be in, and `packages/cli/test/generator-registry.spec.ts` asserts
 * the registry and the config enum name the same kinds.
 *
 * The import thunks stay literal `import('@drzl/generator-…')` expressions rather than being built
 * from `specifier`, because that literal is what the bundler sees; a computed specifier would be
 * left as a runtime lookup with nothing declaring the dependency.
 */
import {
  aiOutDir,
  effectHttpOutDir,
  tsRestOutDir,
  openApiFetchOutDir,
  formsOutDir,
  elysiaOutDir,
  seedOutDir,
  fastCheckOutDir,
  pothosOutDir,
  expressOutDir,
  h3OutDir,
  fastifyOutDir,
  graphqlOutDir,
  honoOutDir,
  mcpOutDir,
  nestjsOutDir,
  nextOutDir,
  tanstackStartOutDir,
  trpcOutDir,
  type DrzlConfig,
  type GeneratorKind,
} from './config.js';
import { expressOptions } from './express-options.js';
import { fastifyOptions } from './fastify-options.js';
import { loadGenerator } from './generator-loader.js';
import { graphqlOptions } from './graphql-options.js';
import { honoOptions } from './hono-options.js';
import { jsonSchemaOptions } from './json-schema-options.js';
import { aiOptions } from './ai-options.js';
import { effectHttpOptions } from './effect-http-options.js';
import { tsRestOptions } from './ts-rest-options.js';
import { openApiFetchOptions } from './openapi-fetch-options.js';
import { formsOptions } from './forms-options.js';
import { elysiaOptions } from './elysia-options.js';
import { seedOptions } from './seed-options.js';
import { fastCheckOptions } from './fast-check-options.js';
import { pothosOptions } from './pothos-options.js';
import { h3Options } from './h3-options.js';
import { mcpOptions } from './mcp-options.js';
import { nextOptions } from './next-options.js';
import { tanstackStartOptions } from './tanstack-start-options.js';
import { nestjsOptions } from './nestjs-options.js';
import { orpcOptions } from './orpc-options.js';
import { serviceOptions } from './service-options.js';
import { trpcOptions } from './trpc-options.js';
import { validationOptions } from './validation-options.js';

/** One entry of `cfg.generators`, as loosely typed here as the option builders take it. */
type GeneratorConfig = DrzlConfig['generators'][number];

/**
 * What a generator hands back.
 *
 * Two shapes, because the packages really do differ: the routers resolve to `{ files }` and the
 * validation generators resolve to the array itself. Normalised by `filesOf` at the one call site
 * rather than by changing seven published signatures.
 */
type GenerateResult = string[] | { files: string[] };

interface GeneratorInstance {
  generate(options: Record<string, unknown>): Promise<GenerateResult>;
}

/** What the registry knows about one generator, and the whole of what a new one has to state. */
export interface GeneratorEntry {
  /** The kind a config names it by, which is also what `--only` accepts. */
  readonly kind: GeneratorKind;
  /** The npm package that carries it, named in the "not installed" message. */
  readonly specifier: string;
  /** A literal `import()`, so the bundler can see the dependency. */
  readonly load: () => Promise<unknown>;
  /** The constructor off that module, applied to an analysis. */
  readonly construct: (module: any, analysis: unknown) => GeneratorInstance;
  /**
   * Where this generator writes, given its config entry.
   *
   * The routers fall back to the top-level `outDir` and the rest have a default directory of their
   * own. `computeGeneratorOutputDirs` has to arrive at the same answer, because the directory a
   * watcher fails to ignore is a directory it regenerates from forever, and
   * `packages/cli/test/generator-registry.spec.ts` compares the two.
   */
  readonly outputDir: (g: GeneratorConfig, cfg: DrzlConfig) => string;
  /** The options object it receives, built by the shared builder for its kind. */
  readonly options: (
    g: GeneratorConfig,
    cfg: DrzlConfig,
    ctx: { outDir: string; servicesDir: string }
  ) => Record<string, unknown>;
}

/**
 * The default directory each generator writes to when its entry names no `path`.
 *
 * Spelled here as well as in `computeGeneratorOutputDirs` for one reason worth keeping: that
 * function is exported from the package's `./config` entry and has been since before the registry
 * existed, so it stays where its consumers expect it. The two are held together by a test rather
 * than by a comment.
 */
const VALIDATOR_DEFAULT_DIRS = {
  zod: 'src/validators/zod',
  valibot: 'src/validators/valibot',
  arktype: 'src/validators/arktype',
  typebox: 'src/validators/typebox',
  effect: 'src/validators/effect',
  'json-schema': 'src/validators/json-schema',
} as const;

/** Where the service generator writes when its entry names no `path`. */
export const SERVICES_DEFAULT_DIR = 'src/services';

/**
 * Where the service generator is writing for this config, whether or not it is being run.
 *
 * The router templates emit an import of a generated service, and the path in that import has to
 * be the path the service generator really used. Computed from the config rather than defaulted
 * inside the templates, because the template's own default is right only by coincidence for a
 * config that puts services elsewhere. `generate` has always computed it; `watch` did not, so a
 * rebuild silently emitted the default.
 */
export function resolveServicesDir(cfg: DrzlConfig): string {
  return cfg.generators.find((g) => g.kind === 'service')?.path ?? SERVICES_DEFAULT_DIR;
}

export const GENERATORS: readonly GeneratorEntry[] = [
  {
    kind: 'orpc',
    specifier: '@drzl/generator-orpc',
    load: () => import('@drzl/generator-orpc'),
    construct: (m, analysis) => new m.ORPCGenerator(analysis),
    // `cfg.outDir` and never `g.path`: see `orpcOptions` for why that is this generator's own
    // arrangement rather than an oversight to correct here.
    outputDir: (_g, cfg) => cfg.outDir,
    options: (g, cfg, ctx) => orpcOptions(g, cfg, ctx.servicesDir),
  },
  {
    kind: 'trpc',
    // This one and seven others were `optionalDependencies` until every one of them had been
    // published: a package that has never existed cannot publish through npm's trusted-publisher
    // OIDC flow, so its first version goes out by hand, and naming it as a hard dependency in the
    // same release breaks `npm i @drzl/cli` for everyone until it does exist. An optional
    // dependency is skipped by the installer instead, which made that release safe.
    //
    // The side effect was invisible and lasted longer than the reason: tsup externalises
    // `dependencies` and `peerDependencies` and bundles everything else, so those eight travelled
    // inside `dist` while the rest were resolved from `node_modules`. Every generator package is on
    // the registry now and every one is a `dependencies` entry, which is what makes each of them a
    // package that can genuinely be absent, and `loadGenerator` tell absence apart from failure for
    // every kind rather than for some of them.
    //
    // Counted nowhere on purpose. This paragraph twice carried a number that the next batch of
    // generators falsified, and `packages/cli/test/generator-registry.spec.ts` asserts the property
    // against the manifest, which is where a quantity belongs.
    specifier: '@drzl/generator-trpc',
    load: () => import('@drzl/generator-trpc'),
    construct: (m, analysis) => new m.TRPCGenerator(analysis),
    outputDir: (g, cfg) => trpcOutDir(g, cfg),
    options: (g, cfg, ctx) => trpcOptions(g, cfg, ctx.servicesDir),
  },
  {
    kind: 'hono',
    specifier: '@drzl/generator-hono',
    load: () => import('@drzl/generator-hono'),
    construct: (m, analysis) => new m.HonoGenerator(analysis),
    outputDir: (g, cfg) => honoOutDir(g, cfg),
    options: (g, cfg) => honoOptions(g, cfg),
  },
  {
    kind: 'express',
    specifier: '@drzl/generator-express',
    load: () => import('@drzl/generator-express'),
    construct: (m, analysis) => new m.ExpressGenerator(analysis),
    outputDir: (g, cfg) => expressOutDir(g, cfg),
    options: (g, cfg) => expressOptions(g, cfg),
  },
  {
    kind: 'fastify',
    specifier: '@drzl/generator-fastify',
    load: () => import('@drzl/generator-fastify'),
    construct: (m, analysis) => new m.FastifyGenerator(analysis),
    outputDir: (g, cfg) => fastifyOutDir(g, cfg),
    options: (g, cfg) => fastifyOptions(g, cfg),
  },
  {
    kind: 'nestjs',
    specifier: '@drzl/generator-nestjs',
    load: () => import('@drzl/generator-nestjs'),
    construct: (m, analysis) => new m.NestJSGenerator(analysis),
    outputDir: (g, cfg) => nestjsOutDir(g, cfg),
    options: (g, cfg) => nestjsOptions(g, cfg),
  },
  {
    kind: 'graphql',
    specifier: '@drzl/generator-graphql',
    load: () => import('@drzl/generator-graphql'),
    construct: (m, analysis) => new m.GraphQLGenerator(analysis),
    outputDir: (g, cfg) => graphqlOutDir(g, cfg),
    options: (g, cfg) => graphqlOptions(g, cfg),
  },
  {
    kind: 'mcp',
    // This one and the three below spent one release each in `optionalDependencies`, because a
    // package that has never existed cannot publish through npm's trusted-publisher OIDC flow and
    // naming it as a hard dependency in the release that introduces it breaks `npm i @drzl/cli`
    // for everyone until the first publish lands. The six generators added after them went the
    // same way and were promoted the same way once their first versions were published by hand.
    // Nothing here is optional any more. `scripts/verify/stages/33-registry-deps.sh` gates both
    // halves of that rule and is what reported each promotion was due.
    specifier: '@drzl/generator-mcp',
    load: () => import('@drzl/generator-mcp'),
    construct: (m, analysis) => new m.MCPGenerator(analysis),
    outputDir: (g, cfg) => mcpOutDir(g, cfg),
    options: (g, cfg) => mcpOptions(g, cfg),
  },
  {
    kind: 'next',
    specifier: '@drzl/generator-next',
    load: () => import('@drzl/generator-next'),
    construct: (m, analysis) => new m.NextGenerator(analysis),
    outputDir: (g, cfg) => nextOutDir(g, cfg),
    options: (g, cfg) => nextOptions(g, cfg),
  },
  {
    kind: 'ai',
    specifier: '@drzl/generator-ai',
    load: () => import('@drzl/generator-ai'),
    construct: (m, analysis) => new m.AIGenerator(analysis),
    outputDir: (g, cfg) => aiOutDir(g, cfg),
    options: (g, cfg) => aiOptions(g, cfg),
  },
  {
    kind: 'tanstack-start',
    specifier: '@drzl/generator-tanstack-start',
    load: () => import('@drzl/generator-tanstack-start'),
    construct: (m, analysis) => new m.TanStackStartGenerator(analysis),
    outputDir: (g, cfg) => tanstackStartOutDir(g, cfg),
    options: (g, cfg) => tanstackStartOptions(g, cfg),
  },
  {
    kind: 'h3',
    specifier: '@drzl/generator-h3',
    load: () => import('@drzl/generator-h3'),
    construct: (m, analysis) => new m.H3Generator(analysis),
    outputDir: (g, cfg) => h3OutDir(g, cfg),
    options: (g, cfg) => h3Options(g, cfg),
  },
  {
    kind: 'effect-http',
    specifier: '@drzl/generator-effect-http',
    load: () => import('@drzl/generator-effect-http'),
    construct: (m, analysis) => new m.EffectHttpGenerator(analysis),
    outputDir: (g, cfg) => effectHttpOutDir(g, cfg),
    options: (g, cfg) => effectHttpOptions(g, cfg),
  },
  {
    kind: 'ts-rest',
    specifier: '@drzl/generator-ts-rest',
    load: () => import('@drzl/generator-ts-rest'),
    construct: (m, analysis) => new m.TsRestGenerator(analysis),
    outputDir: (g, cfg) => tsRestOutDir(g, cfg),
    options: (g, cfg) => tsRestOptions(g, cfg),
  },
  {
    kind: 'openapi-fetch',
    specifier: '@drzl/generator-openapi-fetch',
    load: () => import('@drzl/generator-openapi-fetch'),
    construct: (m, analysis) => new m.OpenApiFetchGenerator(analysis),
    outputDir: (g, cfg) => openApiFetchOutDir(g, cfg),
    options: (g, cfg) => openApiFetchOptions(g, cfg),
  },
  {
    kind: 'forms',
    specifier: '@drzl/generator-forms',
    load: () => import('@drzl/generator-forms'),
    construct: (m, analysis) => new m.FormsGenerator(analysis),
    outputDir: (g, cfg) => formsOutDir(g, cfg),
    options: (g, cfg) => formsOptions(g, cfg),
  },
  {
    kind: 'elysia',
    specifier: '@drzl/generator-elysia',
    load: () => import('@drzl/generator-elysia'),
    construct: (m, analysis) => new m.ElysiaGenerator(analysis),
    outputDir: (g, cfg) => elysiaOutDir(g, cfg),
    options: (g, cfg) => elysiaOptions(g, cfg),
  },
  {
    kind: 'seed',
    specifier: '@drzl/generator-seed',
    load: () => import('@drzl/generator-seed'),
    construct: (m, analysis) => new m.SeedGenerator(analysis),
    outputDir: (g, cfg) => seedOutDir(g, cfg),
    options: (g, cfg) => seedOptions(g, cfg),
  },
  {
    kind: 'fast-check',
    specifier: '@drzl/generator-fast-check',
    load: () => import('@drzl/generator-fast-check'),
    construct: (m, analysis) => new m.FastCheckGenerator(analysis),
    outputDir: (g, cfg) => fastCheckOutDir(g, cfg),
    options: (g, cfg) => fastCheckOptions(g, cfg),
  },
  {
    kind: 'pothos',
    specifier: '@drzl/generator-pothos',
    load: () => import('@drzl/generator-pothos'),
    construct: (m, analysis) => new m.PothosGenerator(analysis),
    outputDir: (g, cfg) => pothosOutDir(g, cfg),
    options: (g, cfg) => pothosOptions(g, cfg),
  },
  {
    kind: 'service',
    specifier: '@drzl/generator-service',
    load: () => import('@drzl/generator-service'),
    construct: (m, analysis) => new m.ServiceGenerator(analysis),
    outputDir: (g) => g.path ?? SERVICES_DEFAULT_DIR,
    options: (g, _cfg, ctx) => serviceOptions(g, ctx.outDir),
  },
  {
    kind: 'zod',
    specifier: '@drzl/generator-zod',
    load: () => import('@drzl/generator-zod'),
    construct: (m, analysis) => new m.ZodGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS.zod,
    // `meta` is zod-only; see `GeneratorCapabilities.meta` for why it is not passed to the other
    // four rather than being passed and ignored.
    options: (g, cfg, ctx) =>
      validationOptions(g, cfg, ctx.outDir, {
        schemaTypes: true,
        meta: true,
        constraints: true,
      }),
  },
  {
    kind: 'valibot',
    specifier: '@drzl/generator-valibot',
    load: () => import('@drzl/generator-valibot'),
    construct: (m, analysis) => new m.ValibotGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS.valibot,
    options: (g, cfg, ctx) =>
      validationOptions(g, cfg, ctx.outDir, { schemaTypes: true, constraints: true }),
  },
  {
    kind: 'arktype',
    specifier: '@drzl/generator-arktype',
    load: () => import('@drzl/generator-arktype'),
    construct: (m, analysis) => new m.ArkTypeGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS.arktype,
    options: (g, cfg, ctx) => validationOptions(g, cfg, ctx.outDir, { schemaTypes: false }),
  },
  {
    kind: 'typebox',
    specifier: '@drzl/generator-typebox',
    load: () => import('@drzl/generator-typebox'),
    construct: (m, analysis) => new m.TypeBoxGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS.typebox,
    options: (g, cfg, ctx) =>
      validationOptions(g, cfg, ctx.outDir, { schemaTypes: true, standardSchema: true }),
  },
  {
    kind: 'effect',
    specifier: '@drzl/generator-effect',
    load: () => import('@drzl/generator-effect'),
    construct: (m, analysis) => new m.EffectGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS.effect,
    options: (g, cfg, ctx) => validationOptions(g, cfg, ctx.outDir, { schemaTypes: true }),
  },
  {
    kind: 'json-schema',
    specifier: '@drzl/generator-json-schema',
    load: () => import('@drzl/generator-json-schema'),
    construct: (m, analysis) => new m.JsonSchemaGenerator(analysis),
    outputDir: (g) => g.path ?? VALIDATOR_DEFAULT_DIRS['json-schema'],
    options: (g, cfg, ctx) => jsonSchemaOptions(g, cfg, ctx.outDir),
  },
];

/** The registry by kind, since every dispatch is a lookup rather than a scan. */
export const GENERATOR_BY_KIND: ReadonlyMap<GeneratorKind, GeneratorEntry> = new Map(
  GENERATORS.map((entry) => [entry.kind, entry])
);

/**
 * The entry for a kind the caller already knows is real.
 *
 * Unreachable in a released build: the only kinds that reach it come from the config enum, and the
 * registry is asserted against that enum by test. It throws rather than returning `undefined` so a
 * kind added to the enum with no entry fails loudly at its first use instead of generating nothing.
 */
export function entryFor(kind: GeneratorKind): GeneratorEntry {
  const entry = GENERATOR_BY_KIND.get(kind);
  if (!entry) throw new Error(`No generator is registered for kind "${kind}".`);
  return entry;
}

/** The files a generator wrote, whichever of the two shapes it resolved to. */
function filesOf(result: GenerateResult): string[] {
  return Array.isArray(result) ? result : result.files;
}

/** Everything a run needs beyond the config entry itself. */
export interface GeneratorRunContext {
  analysis: unknown;
  /**
   * Where the service generator is really writing, so a router template that imports services
   * spells a path that exists. Read by the oRPC and tRPC builders and ignored by the rest.
   */
  servicesDir: string;
  /**
   * The write plan, when the caller is keeping one. Absent for `watch`, which writes straight to
   * disk, and the key is omitted rather than passed as `undefined` so a generator that asks
   * whether it was given a sink gets the same answer it did before this existed.
   */
  fileSink?: unknown;
  /** Per-table progress, for the bar. Only the router generators report it. */
  onProgress?: (progress: { index: number }) => void;
}

/**
 * Load one generator, build its options, run it, and say which files it wrote.
 *
 * The one place any of that happens. A package that is not installed comes back out of
 * `loadGenerator` as `GeneratorNotInstalledError`, which is what lets the caller print the install
 * line instead of a stack trace; everything else the generator throws comes out unchanged, so a
 * generator that is present and merely failing says what really went wrong.
 */
export async function runGenerator(
  entry: GeneratorEntry,
  g: GeneratorConfig,
  cfg: DrzlConfig,
  ctx: GeneratorRunContext
): Promise<string[]> {
  return runGeneratorWithOptions(entry, ctx.analysis, {
    ...entry.options(g, cfg, {
      outDir: entry.outputDir(g, cfg),
      servicesDir: ctx.servicesDir,
    }),
    ...(ctx.fileSink ? { fileSink: ctx.fileSink } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  });
}

/**
 * Load one generator and run it against options the caller built itself.
 *
 * For the two deprecated per-kind commands, which pass the small option set they have always
 * passed rather than the config-shaped one. They share the loading, the constructor and the
 * two-shaped result with everything else, which is all four copies of that down to one; what they
 * keep is their own options, deliberately, because a command being kept alive for compatibility
 * has to keep emitting the bytes it emitted.
 */
export async function runGeneratorWithOptions(
  entry: GeneratorEntry,
  analysis: unknown,
  options: Record<string, unknown>
): Promise<string[]> {
  const module = await loadGenerator(entry.specifier, entry.load);
  return filesOf(await entry.construct(module, analysis).generate(options));
}
