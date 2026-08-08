import type { AffixOptions } from '@drzl/validation-core';
import {
  AFFIX_PROBE_TABLE,
  DEFAULT_IMPORT_EXTENSION,
  IMPORT_EXTENSIONS,
  NAME_MODES,
  resolveAffix,
  schemaName,
  validateAffix,
} from '@drzl/validation-core';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { z } from 'zod';
import { ambiguousPatternWarnings, matchesTable } from './patterns.js';

export const NamingSchema = z
  .object({
    routerSuffix: z.string().default('Router'),
    procedureCase: z.enum(['camel', 'kebab', 'snake']).default('camel'),
  })
  .partial();

/** One affix for every mode, or a per-mode map. Keys match drzl's internal mode names. */
const AffixValueSchema = z.union(
  [
    z.string(),
    z
      .object({
        insert: z.string().optional(),
        update: z.string().optional(),
        select: z.string().optional(),
      })
      .strict(),
  ],
  {
    error:
      'Expected a string to use for every mode, or an object with any of the keys "insert", ' +
      '"update" and "select". Those keys are lowercase, matching the mode names drzl uses ' +
      'everywhere else.',
  }
);

const AffixPartSchema = z
  .object({
    prefix: AffixValueSchema.optional(),
    suffix: AffixValueSchema.optional(),
  })
  .strict();

export const AffixSchema = z
  .object({
    /**
     * `preserve` (default) keeps today's output: the Drizzle export name goes into the
     * identifier verbatim, so `export const users` yields `InsertusersSchema`. `pascal`
     * upper-camels it first, yielding `InsertUsersSchema`.
     */
    tableCase: z.enum(['preserve', 'pascal']).optional(),
    schema: AffixPartSchema.optional(),
    type: AffixPartSchema.optional(),
  })
  .strict();

/**
 * How every relative specifier drzl invents spells its extension.
 *
 * The generated files land in the consumer's own source tree, so the consumer's
 * `moduleResolution` decides which forms resolve. `js` is the only one that resolves under
 * all of `bundler`, `node10`, `node16` and `nodenext` with no compiler flag, so it is the
 * default. See the `ImportExtension` docs in `@drzl/validation-core` for the measured grid.
 */
export const ImportExtensionSchema = z.enum(IMPORT_EXTENSIONS);

export const GeneratorSchema = z.object({
  kind: z.enum([
    'orpc',
    'trpc',
    'hono',
    'express',
    'fastify',
    'service',
    'zod',
    'valibot',
    'arktype',
    'typebox',
    'effect',
    'json-schema',
  ]),
  /**
   * Which of Hono's two official validator middlewares the emitted routes carry, and therefore
   * which package they import. `hono` only.
   *
   * `standard` is `sValidator` from `@hono/standard-validator`, which takes any Standard Schema
   * and so works with every library `validation.library` can name. `zod` is `zValidator` from
   * `@hono/zod-validator`, which is zod-specific.
   */
  validator: z.enum(['standard', 'zod']).optional(),
  /**
   * Overrides the top-level `importExtension` for this generator alone, for a project whose
   * generated directories are compiled by different tsconfigs.
   */
  importExtension: ImportExtensionSchema.optional(),
  template: z.string().optional(),
  includeRelations: z.boolean().optional(),
  /**
   * Write an enum used by two or more columns once under `$defs` in the `json-schema` per-table
   * modules, and `$ref` it at each use.
   *
   * Off by default, and the reason is a consumer pattern rather than a doubt about the keyword. A
   * per-table schema is used whole and one property at a time, and a `$ref` cannot survive being
   * pulled out with its property: `properties[col]` compiled on its own is a dangling reference
   * that ajv refuses outright. The OpenAPI document shares regardless, because a document is only
   * ever read whole.
   */
  sharedEnums: z.boolean().optional(),
  /**
   * Type `json` and `jsonb` columns from the schema rather than leaving them wide.
   *
   * `.$type<T>()` is a compile-time cast, so no runtime-derived validator can see it and
   * `drizzle-orm/zod` types every json column as its generic `Json`. A generator can reference
   * `typeof <table>.$inferSelect['<column>']` instead, which is the declared type resolved by
   * TypeScript itself, so generics, unions and imported interfaces all work.
   *
   * Off by default because it makes the generated file import your schema module, as a
   * type-only import that disappears at build time.
   */
  // What a date column accepts. Documented on the zod generator and, until now, accepted by the
  // config parser and then dropped on the floor: the generators default it to 'input' themselves,
  // so setting it here changed nothing.
  coerceDates: z.enum(['input', 'all', 'none']).optional(),
  typedJson: z.boolean().optional(),
  // The wider form: every column's static type comes from Drizzle, not just the untyped ones.
  typedColumns: z.boolean().optional(),
  // Reproduce literal column defaults in the insert schema, so parsing fills them in.
  applyDefaults: z.boolean().optional(),
  /**
   * Emit `findDuplicate<Table>` beside the schemas: the rows in a batch that collide with an
   * earlier row on a unique constraint.
   *
   * Uniqueness is the one constraint a per-row validator structurally cannot see, since it is a
   * fact about the table rather than the row. This checks the half that needs no database.
   */
  duplicateFinder: z.boolean().optional(),
  /**
   * zod and valibot. Also emit `constraints.ts`: every CHECK, unique constraint, primary and
   * foreign key on each table as plain data, plus `constraintForIssue`, which maps a validation
   * issue back to the constraint that caused it.
   *
   * For building forms. A schema states what a value must look like and never says which
   * constraint said so, so a failed parse hands a form a message and no way to attribute it; and
   * uniqueness and foreign keys, the two constraints no per-row schema can check, are absent from
   * the emitted schemas in every form.
   *
   * Not `meta` written to a second file. `meta` describes a *field* and travels with the schema
   * into `z.toJSONSchema`; this describes the table's *constraints*, carries their names, states
   * each operand as data rather than inside a sentence, and is read without holding a schema.
   *
   * `true` is the shorthand for `{ enabled: true }`. `{ errorMap: false }` emits the data alone,
   * without the matcher.
   */
  constraints: z
    .union([
      z.boolean(),
      z.object({ enabled: z.boolean().optional(), errorMap: z.boolean().optional() }).strict(),
    ])
    .optional(),
  /**
   * zod only. Attach the facts the analyzer knows and a zod schema cannot state, as `.meta()` on
   * every field and every table schema: the declared SQL type, the primary key, the unique
   * constraints, whether the database generates or defaults the value, and the CHECK constraints,
   * including the ones DRZL declined to enforce.
   *
   * `z.toJSONSchema` copies these through, so they are also how an OpenAPI document built from the
   * emitted schemas gets the declared width back: DRZL enforces one as a `.refine()`, and
   * `toJSONSchema` drops every refinement in silence.
   *
   * `true` is the shorthand for `{ enabled: true }`. `{ description: true }` additionally writes a
   * `description`, which is what an OpenAPI viewer renders to a human.
   */
  meta: z
    .union([
      z.boolean(),
      z.object({ enabled: z.boolean().optional(), description: z.boolean().optional() }).strict(),
    ])
    .optional(),
  /**
   * TypeBox only. Give every emitted schema a `~standard` key, so it can be handed to a tRPC or
   * oRPC route.
   *
   * TypeBox is the one validator DRZL emits that carries none of its own: measured on 0.34.52, a
   * bare `Type.Object()` has no `~standard` and the package exports nothing matching
   * `/standard/i`. zod, valibot and arktype all put one on every schema they build, so the option
   * does nothing for them and is not passed through.
   *
   * The property is non-enumerable, so the schema stays a TypeBox schema in every respect that was
   * already observable, including the JSON Schema `JSON.stringify` produces.
   */
  standardSchema: z.boolean().optional(),
  /**
   * Emit `NestedInsert<Table>` and `NestedSelect<Table>` beside the flat schemas: the table plus
   * one key per relation, so `{ ...user, posts: [...] }` can be validated whole.
   *
   * Nothing in the Drizzle validator ecosystem describes that payload, and `db.insert` drops the
   * relation key silently rather than refusing it, so the children are never written and nothing
   * says so.
   */
  nestedSchemas: z.boolean().optional(),
  /**
   * How many levels of children a nested schema describes. Defaults to 1, capped at 3.
   *
   * Nesting is expanded inline rather than by reference, so this multiplies the emitted size, and
   * it is also what terminates a cycle: `users -> posts -> users` stops here.
   */
  nestedDepth: z.number().int().optional(),
  /**
   * Give every primary key, and every foreign key pointing at one, a nominal type, so a
   * `users.id` cannot be passed where a `posts.id` is wanted.
   *
   * Type level only, in all five validators. Measured on zod 4.4.3, `.brand()` returns the same
   * schema object it was called on and the parsed value of `1` is `1`, so nothing about what a
   * schema accepts changes and no bytes are added to the bundle. TypeBox has no brand of its own
   * and gets a `TUnsafe` cast, which leaves the schema object identical.
   *
   * Off by default: it changes the inferred type of every consumer of the select schemas, which
   * is the point, but it is a change to existing call sites rather than an addition.
   *
   * `true` is the shorthand for `{ enabled: true }`. `{ foreignKeys: false }` brands only the
   * keys themselves, and `{ aliases: false }` stops the `export type UsersId = ...` lines.
   */
  branded: z
    .union([
      z.boolean(),
      z
        .object({
          enabled: z.boolean().optional(),
          foreignKeys: z.boolean().optional(),
          aliases: z.boolean().optional(),
        })
        .strict(),
    ])
    .optional(),
  naming: NamingSchema.optional(),
  outputHeader: z
    .object({
      enabled: z.boolean().default(true).optional(),
      text: z.string().optional(),
    })
    .optional(),
  format: z
    .object({
      enabled: z.boolean().default(true).optional(),
      engine: z.enum(['auto', 'prettier', 'biome']).default('auto').optional(),
      configPath: z.string().optional(),
    })
    .optional(),
  /**
   * Which spelling of JSON Schema the `json-schema` generator emits.
   *
   * OpenAPI 3.0 is not an older superset of the 2020-12 draft, it is a different dialect: a
   * nullable type is `nullable: true` rather than a type array, and an exclusive bound is a
   * boolean flag beside the bound rather than its own keyword. An unknown keyword is not an error
   * in JSON Schema, it is ignored, so emitting the wrong dialect produces a document that
   * validates and then accepts the values the constraints exist to reject.
   */
  target: z.enum(['draft-2020-12', 'openapi-3.1', 'openapi-3.0']).optional(),
  /** Also emit `components.ts` for the `json-schema` generator, ready for an OpenAPI document. */
  components: z.boolean().optional(),
  /**
   * Also emit the whole OpenAPI document for the `json-schema` generator: paths, verbs, request and
   * response bodies per table, with `components.schemas` embedded so the file stands alone.
   *
   * `true` is the short form. The object form carries the three things a Drizzle schema genuinely
   * cannot say: what the API is called, where it is served, and which status code that particular
   * server answers a request that fails its schema with.
   */
  document: z
    .union([
      z.boolean(),
      z
        .object({
          enabled: z.boolean().optional(),
          /** `ts` (default) writes a module, `json` the file OpenAPI tooling reads directly. */
          format: z.enum(['ts', 'json', 'both']).optional(),
          info: z
            .object({
              title: z.string().optional(),
              version: z.string().optional(),
              description: z.string().optional(),
            })
            .strict()
            .optional(),
          /**
           * Omitted by default, which the specification reads as a single server at `/`: the
           * document describes whatever is serving it. A placeholder host would be a fabrication
           * that tooling then follows.
           */
          servers: z
            .array(z.object({ url: z.string(), description: z.string().optional() }).strict())
            .optional(),
          /** 400 by default. 422 is the other defensible reading; exactly one is emitted. */
          validationStatus: z.union([z.literal(400), z.literal(422)]).optional(),
        })
        .strict(),
    ])
    .optional(),
  // service generator specific options
  path: z.string().optional(),
  dataAccess: z.enum(['stub', 'drizzle']).default('stub').optional(),
  dbImportPath: z.string().optional(),
  schemaImportPath: z.string().optional(),
  // zod/valibot/arktype generator specific options
  schemaSuffix: z.string().optional(),
  fileSuffix: z.string().optional(),
  /**
   * Prefixes, suffixes and table casing for generated identifiers (zod/valibot/arktype).
   * Omitting it reproduces the output of every previous release exactly.
   */
  affix: AffixSchema.optional(),
  /**
   * How the router generators reach a database handle: through the request context, rather than
   * through a module-level import in the service layer.
   *
   * Documented on the oRPC generator since it was added and, until now, absent from this schema
   * entirely. `GeneratorSchema` is not strict, so zod stripped the key without a word and the
   * option did nothing at all when set from a config file. It was only ever reachable by calling
   * the generator's API directly.
   */
  databaseInjection: z
    .object({
      enabled: z.boolean().optional(),
      /** The type annotation for the injected handle, e.g. `DrizzleD1Database`. */
      databaseType: z.string().optional(),
      databaseTypeImport: z.object({ name: z.string(), from: z.string() }).optional(),
    })
    .optional(),
  // router validation sharing (orpc, trpc)
  validation: z
    .object({
      useShared: z.boolean().default(false).optional(),
      library: z.enum(['zod', 'valibot', 'arktype']).default('zod').optional(),
      importPath: z.string().optional(),
      schemaSuffix: z.string().optional(),
      /**
       * How the validation generator named its exports. Usually left unset: the CLI copies
       * it from the sibling generator whose `kind` matches `library`.
       */
      affix: AffixSchema.optional(),
    })
    .optional(),
  // template options
  templateOptions: z.record(z.string(), z.any()).optional(),
});

/**
 * One table's column rules. Strict, so `ommit` is refused by the parser rather than dropped.
 *
 * The whole option exists to remove a column, and a key zod strips in silence is a config that
 * looks like it removed one and did not. `GeneratorSchema` is deliberately not strict and has
 * already cost this repo two options that parsed and then did nothing.
 */
export const ColumnRulesSchema = z
  .object({
    omit: z.array(z.string()).optional(),
    pick: z.array(z.string()).optional(),
  })
  .strict();

export const AnalyzerSchema = z.object({
  includeRelations: z.boolean().default(true),
  validateConstraints: z.boolean().default(true),
  includeHeuristicRelations: z.boolean().default(false),
});

export const ConfigSchema = z
  .object({
    schema: z.string(),
    outDir: z.string().default('src/api'),
    /**
     * Which tables to generate for, matched against the database table name.
     *
     * There was no way to say this, and every generator loops over every table it finds, so
     * DRZL emitted unauthenticated CRUD over whatever shared the schema file. That is noise for
     * a migrations table and a genuine leak for an auth one: Better Auth puts `user`, `session`,
     * `account` and `verification` alongside your own tables, and `account` holds
     * `accessToken`, `refreshToken`, `idToken` and `password`.
     *
     * Deliberately name-based and explicit rather than detecting any particular library. Auth
     * table names are all renameable, so a built-in list would miss renamed tables and, worse,
     * silently skip an ordinary table that happened to be called `user`, which is usually the
     * application's main entity.
     *
     * `exclude` wins over `include`. Patterns support `*`, matching within a name.
     */
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    /**
     * Which columns of those tables to generate for, keyed by table.
     *
     * `include`/`exclude` is all or nothing per table, and the column that should not be in a
     * generated schema is usually sitting in a table you do want: `passwordHash` on `users`, an
     * internal note beside the public fields, a `tenantId` the server sets from the session and a
     * request body must not carry. Editing the emitted file is not an answer, because the next
     * `drzl generate` overwrites it.
     *
     * ```ts
     * columns: {
     *   users: { omit: ['passwordHash'] },
     *   'app_*': { omit: ['deleted_at'] },
     * }
     * ```
     *
     * The key is a table pattern in the same language `include`/`exclude` uses: the database table
     * name, anchored, with `*` as the only metacharacter. Column patterns are the same language
     * again. Every matching entry applies, in the order written; within one entry `pick` narrows
     * first and `omit` then removes, so `omit` wins, exactly as `exclude` wins over `include`.
     *
     * Applies to every mode and every generator at once, because it narrows the analysis rather
     * than any one generator's output. A column cannot be kept in `select` and dropped from
     * `insert`: see the docs for why that form was not taken on.
     *
     * A pattern that matches nothing is an error rather than a no-op, because a typo in `omit`
     * that silently does nothing leaves the column exactly where it was while reading like a fix.
     * Dropping a primary key column is an error too; dropping a NOT NULL column with no default is
     * a warning.
     */
    columns: z.record(z.string(), ColumnRulesSchema).optional(),
    /**
     * How every relative specifier drzl invents spells its extension, for every generator.
     * A generator may override it. Defaults to `js`, which is the only form that resolves
     * under every `moduleResolution` without a compiler flag.
     */
    importExtension: ImportExtensionSchema.default(DEFAULT_IMPORT_EXTENSION),
    analyzer: AnalyzerSchema.default({
      includeRelations: true,
      validateConstraints: true,
      includeHeuristicRelations: false,
    }),
    generators: z
      .array(GeneratorSchema)
      .min(1)
      .default([{ kind: 'orpc' } as any]),
  })
  // Reject an affix before anything is written, rather than emitting a file that cannot
  // compile. Only `affix` is inspected; the legacy flat `schemaSuffix` is left alone so
  // configs that parse today keep parsing.
  .superRefine((cfg, ctx) => {
    cfg.generators.forEach((g, i) => {
      const report = (base: (string | number)[], affix?: AffixOptions, schemaSuffix?: string) => {
        for (const issue of validateAffix(affix, schemaSuffix)) {
          ctx.addIssue({
            code: 'custom',
            path: ['generators', i, ...base, ...issue.path],
            message: issue.message,
          });
        }
      };
      report(['affix'], g.affix as AffixOptions | undefined, g.schemaSuffix);
      report(
        ['validation', 'affix'],
        g.validation?.affix as AffixOptions | undefined,
        g.validation?.schemaSuffix
      );
    });
  });

// ✨ Separate input vs output types
export type DrzlConfigInput = z.input<typeof ConfigSchema>;
export type DrzlConfig = z.output<typeof ConfigSchema>;

export function defineConfig<T extends DrzlConfigInput>(cfg: T): T {
  return cfg;
}

type GeneratorConfig = DrzlConfig['generators'][number];

/** The generators that emit an RPC router, and so share `outDir` and `validation`. */
/** The generators that import the validation generators' exports by name. */
const ROUTER_KINDS = new Set(['orpc', 'trpc', 'hono', 'express']);

/**
 * The routers that can reach a database through the request context.
 *
 * `hono` and `express` are deliberately absent. `databaseInjection` is a contract between a
 * router and `@drzl/generator-service`, and neither generator emits service delegation at all:
 * their handlers are stubs a consumer fills in, and neither has a template that would call one.
 * Letting the option through would push `databaseInjection` onto the service generator on behalf
 * of a router that never uses it, which is the shape of dead option this config has already
 * shipped twice.
 */
const INJECTION_KINDS = new Set(['orpc', 'trpc']);

/**
 * Where the tRPC generator writes.
 *
 * `outDir` by default, exactly like oRPC, so a config that names one router generator puts its
 * output where the top-level setting says. `path` is the escape hatch, and a config that runs
 * *both* router generators needs it: they would otherwise write two different `index.ts` files to
 * the same directory and the second would win.
 *
 * Exported because `computeGeneratorOutputDirs` has to agree with the dispatch in cli.ts about
 * this, and the watcher ignoring the wrong directory is an infinite regeneration loop.
 */
export function trpcOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the Hono generator writes.
 *
 * The same rule as the other two routers, and for the same reason: it writes an `index.ts` of its
 * own, so a config running two router generators has to give at least one of them a `path`.
 *
 * Its own function rather than a call to `trpcOutDir`, because these are three separate decisions
 * that happen to agree today, and a reader following `computeGeneratorOutputDirs` should not have
 * to work out whether a function named for tRPC is authoritative for Hono.
 */
export function honoOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the Express generator writes.
 *
 * The same rule as the other three routers, and for the same reason: it writes an `index.ts` of
 * its own, so a config running two router generators has to give at least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records:
 * these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which router's function is
 * authoritative for which kind.
 */
export function expressOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the Fastify generator writes.
 *
 * The same rule as the other four routers, and for the same reason: it writes an `index.ts` of
 * its own, so a config running two router generators has to give at least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records:
 * these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which router's function is
 * authoritative for which kind.
 */
export function fastifyOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

function sharedSchemaNames(opts: { affix?: AffixOptions; schemaSuffix?: string }): string[] {
  const resolved = resolveAffix(opts);
  return NAME_MODES.map((mode) => schemaName(mode, AFFIX_PROBE_TABLE, resolved));
}

/**
 * Fill in cross-generator defaults and refuse configs whose generators would disagree.
 *
 * An oRPC router that imports shared schemas has to spell the exact names the validation
 * generator exported. Both sides used to be configured independently, so they could silently
 * drift into a router that does not compile. When an oRPC generator uses shared validation
 * and exactly one sibling generator produces that library, its `affix` is copied across.
 *
 * Deliberately conservative about the pre-existing flat `schemaSuffix`: a disagreement there
 * is only reported, never repaired, because repairing it would change the bytes an existing
 * config emits.
 *
 * `importExtension` is pushed down here too. A consumer compiles the whole generated tree
 * with one tsconfig, so the setting that has to hold is the same for every generator, and
 * every call site downstream can then read it off the generator without knowing about the
 * top-level default.
 */
export function resolveConfig(cfg: DrzlConfig): { config: DrzlConfig; warnings: string[] } {
  const warnings: string[] = [];
  const generators: GeneratorConfig[] = cfg.generators.map((g) => ({
    ...g,
    importExtension: g.importExtension ?? cfg.importExtension,
  }));

  for (const g of generators) {
    /**
     * The Fastify generator is a router that belongs to neither set below. Its schemas are JSON
     * Schema built by the same code as the `json-schema` generator and inlined at generation
     * time, so there is no validation library to choose and no shared schema module to import,
     * and its handlers are stubs that never call a service. Both options would otherwise parse
     * and then do nothing, which is the shape of dead option this config has already shipped
     * twice, so each is refused with a warning here instead.
     */
    if (g.kind === 'fastify') {
      if (g.databaseInjection?.enabled) {
        warnings.push(
          `drzl config: the "fastify" generator sets databaseInjection.enabled, which it does ` +
            `not support. Its handlers are stubs and never call a service, so nothing reads ` +
            `the injected handle. Reach your database from inside the handler bodies you fill ` +
            `in, or use the "trpc" or "orpc" generator, which do delegate to ` +
            `@drzl/generator-service.`
        );
      }
      if (g.validation) {
        warnings.push(
          `drzl config: the "fastify" generator sets "validation", which it does not read. Its ` +
            `route schemas are JSON Schema produced by the same builder as the "json-schema" ` +
            `generator and inlined into the routes, so there is no library to choose and no ` +
            `shared schema module to import. Remove the block.`
        );
      }
      continue;
    }

    // Both router generators import the validation generators' exports by name, so both have to
    // spell them the way the sibling generator wrote them.
    if (!ROUTER_KINDS.has(g.kind)) continue;

    /**
     * `databaseInjection` describes a contract between two generators, not a setting of one.
     *
     * A router in injection mode emits `Service.getById(ctx.db, id)`, and only a service
     * generated in the same mode has a `db` parameter to receive it. Declared once on the router
     * and pushed onto the service generator here, exactly as `validation.affix` is pulled the
     * other way, because the alternative is writing the same block twice and a project that
     * compiles in halves and not as a whole.
     *
     * `@drzl/generator-service` honours the flag only while emitting real Drizzle queries: its
     * stub bodies take no database whatever they are told. That combination cannot be repaired
     * from here without changing what an existing config emits, so it is reported instead.
     */
    if (g.databaseInjection?.enabled && !INJECTION_KINDS.has(g.kind)) {
      warnings.push(
        `drzl config: the "${g.kind}" generator sets databaseInjection.enabled, which it does ` +
          `not support. Its handlers are stubs and never call a service, so nothing reads the ` +
          `injected handle. Reach your database from inside the handler bodies you fill in, or ` +
          `use the "trpc" or "orpc" generator, which do delegate to @drzl/generator-service.`
      );
    } else if (g.databaseInjection?.enabled) {
      for (const s of generators.filter((x) => x.kind === 'service')) {
        if (!s.databaseInjection) {
          s.databaseInjection = g.databaseInjection;
        } else if (!s.databaseInjection.enabled) {
          warnings.push(
            `drzl config: the "${g.kind}" generator sets databaseInjection.enabled while the ` +
              `"service" generator sets it to false. The router will call ` +
              `Service.method(ctx.db, ...) against services that take no database parameter, so ` +
              `the generated project will not compile. Set both, or neither.`
          );
        }
        if ((s.dataAccess ?? 'stub') === 'stub') {
          warnings.push(
            `drzl config: the "${g.kind}" generator sets databaseInjection.enabled, so its ` +
              `handlers call Service.method(ctx.db, ...). The "service" generator emits stub ` +
              `bodies, which take no database parameter whatever this option says, so those ` +
              `calls will not compile. Set dataAccess: 'drizzle' on the "service" generator, or ` +
              `drop databaseInjection.`
          );
        }
      }
    }

    const v = g.validation;
    if (!v?.useShared) continue;

    const library = v.library ?? 'zod';
    const siblings = generators.filter((s) => s.kind === library);
    // Zero siblings means the user points at a barrel drzl does not generate; more than one
    // means there is no single source of truth. Either way, leave the config alone.
    if (siblings.length !== 1) continue;
    const sibling = siblings[0];

    const theirs = sharedSchemaNames({
      affix: sibling.affix as AffixOptions | undefined,
      schemaSuffix: sibling.schemaSuffix,
    });

    if (!v.affix) {
      if (sibling.affix) {
        // Bake the sibling's fully resolved naming in, so its own schemaSuffix fallback
        // travels with it and cannot be re-interpreted on the oRPC side.
        g.validation = {
          ...v,
          affix: resolveAffix({
            affix: sibling.affix as AffixOptions,
            schemaSuffix: sibling.schemaSuffix,
          }),
        };
        continue;
      }
      const mine = sharedSchemaNames({ schemaSuffix: v.schemaSuffix });
      if (mine.join(',') !== theirs.join(',')) {
        warnings.push(
          `drzl config: the "${g.kind}" generator's validation.schemaSuffix ` +
            `(${JSON.stringify(v.schemaSuffix ?? 'Schema')}) does not match the "${library}" ` +
            `generator's schemaSuffix (${JSON.stringify(sibling.schemaSuffix ?? 'Schema')}). ` +
            `The router will import ${mine.join(', ')} but the "${library}" generator exports ` +
            `${theirs.join(', ')}, so the generated router will not compile. Set both to the ` +
            `same value, or move to "affix", which is inherited automatically.`
        );
      }
      continue;
    }

    const mine = sharedSchemaNames({
      affix: v.affix as AffixOptions,
      schemaSuffix: v.schemaSuffix,
    });
    if (mine.join(',') !== theirs.join(',')) {
      throw new Error(
        `drzl config: the "${g.kind}" generator imports shared ${library} schemas, but its ` +
          `validation.affix disagrees with the "${library}" generator's own naming. The router ` +
          `would import ${mine.join(', ')} while the "${library}" generator exports ` +
          `${theirs.join(', ')}. Make them match, or drop validation.affix and let it be ` +
          `inherited from the "${library}" generator.`
      );
    }
  }

  return { config: { ...cfg, generators }, warnings };
}

/**
 * Parse, then resolve cross-generator defaults. Both `generate` and `watch` go through
 * loadConfig, so putting the resolution here is what keeps the two duplicated generator
 * dispatch blocks in cli.ts from needing the logic twice.
 */
function finalize(raw: unknown): DrzlConfig {
  const { config, warnings } = resolveConfig(ConfigSchema.parse(raw));
  for (const w of warnings) console.warn(w);
  return config;
}

export async function loadConfig(customPath?: string): Promise<DrzlConfig | null> {
  const fsp = await import('node:fs/promises');

  const candidates = customPath
    ? [customPath]
    : [
        'drzl.config.ts',
        'drzl.config.mjs',
        'drzl.config.js',
        'drzl.config.cjs',
        'drzl.config.json',
      ];

  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    try {
      await fsp.access(p);
    } catch {
      continue;
    }

    const ext = path.extname(p).toLowerCase();

    // JSON: read directly
    if (ext === '.json') {
      const raw = JSON.parse(await fsp.readFile(p, 'utf8'));
      return finalize(raw);
    }

    // Everything else (TS/JS/MJS/CJS) -> Jiti with cache-busting
    const { createJiti } = await import('jiti');
    const stat = await fsp.stat(p);

    // Passing __filename is safe in CJS; fallback to cwd if not defined.
    const base =
      typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'index.js');

    const jiti = createJiti(base, {
      moduleCache: false, // re-evaluate each time
      fsCache: true, // keep transform cache
      cacheVersion: String(stat.mtimeMs), // bump on edit
      interopDefault: true,
      tryNative: false, // <-- prevent native import of .ts
      // debug: true,
    }) as any;

    const mod = await jiti.import(p);
    const raw = mod?.default ?? mod;
    return finalize(raw);
  }

  return null;
}

/** Absolute output dirs for all generators (to ignore in watcher). */
export function computeGeneratorOutputDirs(cfg: DrzlConfig, cwd = process.cwd()): string[] {
  const abs = (p: string) => path.resolve(cwd, p);
  const dirs = new Set<string>();
  dirs.add(abs(cfg.outDir)); // orpc
  for (const g of cfg.generators) {
    if (g.kind === 'trpc') dirs.add(abs(trpcOutDir(g, cfg)));
    if (g.kind === 'hono') dirs.add(abs(honoOutDir(g, cfg)));
    if (g.kind === 'express') dirs.add(abs(expressOutDir(g, cfg)));
    if (g.kind === 'fastify') dirs.add(abs(fastifyOutDir(g, cfg)));
    if (g.kind === 'service') dirs.add(abs(g.path ?? 'src/services'));
    if (g.kind === 'zod') dirs.add(abs(g.path ?? 'src/validators/zod'));
    if (g.kind === 'valibot') dirs.add(abs(g.path ?? 'src/validators/valibot'));
    if (g.kind === 'arktype') dirs.add(abs(g.path ?? 'src/validators/arktype'));
    if (g.kind === 'typebox') dirs.add(abs(g.path ?? 'src/validators/typebox'));
    if (g.kind === 'effect') dirs.add(abs(g.path ?? 'src/validators/effect'));
    if (g.kind === 'json-schema') dirs.add(abs(g.path ?? 'src/validators/json-schema'));
  }
  return [...dirs];
}

/** Resolve custom template directories (local path or installed package). */
export function resolveTemplateDirsSync(cfg: DrzlConfig, cwd = process.cwd()): string[] {
  const results: string[] = [];
  const req = createRequire(
    typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'index.js')
  );

  for (const g of cfg.generators) {
    const t = g.template;
    // Built-in template names, not packages. `service` is the tRPC generator's, and without it
    // here every run would try to resolve a package called "service" and then watch a directory
    // of that name, neither of which exists.
    if (!t || t === 'standard' || t === 'minimal' || t === 'service') continue;

    // Try package resolution relative to cwd
    let pkgDir: string | null = null;
    try {
      const pkg = req.resolve(`${t}/package.json`, { paths: [cwd] as any });
      pkgDir = path.dirname(pkg);
    } catch {}

    if (pkgDir) {
      results.push(pkgDir);
      continue;
    }

    // Local path-like template
    if (/[./\\]/.test(t)) {
      const abs = path.resolve(cwd, t);
      if (fs.existsSync(abs)) results.push(abs);
    }
  }

  return Array.from(new Set(results));
}

/** Build watch targets (exclude output dirs; watcher will ignore those). */
/**
 * Narrow an analysis's tables to the ones the config asked for.
 *
 * Matching is on the database table name, anchored, with `*` as the only metacharacter. Anchored
 * matters: `user` must not also drop `users`, and a substring match would. `exclude` is applied
 * after `include`, so the safer direction wins when both name the same table.
 *
 * A table also answers to its schema-qualified name, so `reporting.users` addresses one of two
 * same-named tables and `reporting.*` addresses a whole schema. See `tableAliases`.
 */
export function filterTables<T extends { name: string; schema?: string }>(
  tables: T[],
  opts: { include?: string[]; exclude?: string[] }
): T[] {
  let out = tables;
  if (opts.include?.length) out = out.filter((t) => matchesTable(opts.include!, t));
  if (opts.exclude?.length) out = out.filter((t) => !matchesTable(opts.exclude!, t));
  return out;
}

/**
 * What to warn about the table filter, before it is applied.
 *
 * Separate from `filterTables` so that returns a plain array, as every caller and every test
 * already expects it to.
 */
export function tableFilterWarnings(
  tables: readonly { name: string; schema?: string }[],
  opts: { include?: string[]; exclude?: string[] }
): string[] {
  return [
    ...ambiguousPatternWarnings(opts.include ?? [], tables, 'include'),
    ...ambiguousPatternWarnings(opts.exclude ?? [], tables, 'exclude'),
  ];
}

export function computeWatchTargets(cfg: DrzlConfig, cwd = process.cwd()): string[] {
  const abs = (p: string) => path.resolve(cwd, p);
  const schemaAbs = abs(cfg.schema);
  // The schema's directory, not a glob under it. Chokidar removed glob support in v4 and treats
  // `<dir>/**/*.{ts,tsx,js}` as a literal path, so it watched a directory named `**` that does
  // not exist: no event ever fired and `drzl watch` did its initial build and then sat inert.
  // A directory is watched recursively by chokidar itself, and the extension filtering that the
  // glob was doing now happens on the event instead.
  const targets = new Set<string>([
    path.dirname(schemaAbs),
    abs('drzl.config.ts'),
    abs('drzl.config.js'),
    abs('drzl.config.mjs'),
    abs('drzl.config.cjs'),
  ]);
  for (const t of resolveTemplateDirsSync(cfg, cwd)) targets.add(t);
  return [...targets];
}
