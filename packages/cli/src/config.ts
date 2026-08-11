import type { AffixOptions } from '@drzl/validation-core';
import {
  AFFIX_PREFIX_PATTERN,
  AFFIX_PROBE_TABLE,
  AFFIX_SUFFIX_PATTERN,
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
import {
  ConfigValidationError,
  formatConfigProblems,
  unknownKeyWarnings,
} from './config-errors.js';
import { ambiguousPatternWarnings, matchesTable } from './patterns.js';

export const NamingSchema = z
  .object({
    routerSuffix: z.string().default('Router'),
    procedureCase: z.enum(['camel', 'kebab', 'snake']).default('camel'),
    /**
     * Placed in front of every generated MCP tool name, so one server can carry two schemas
     * without collision: `db.users_list` rather than `users_list`. `mcp` only.
     *
     * There is no equivalent for the other kinds because there is nothing to collide: a router's
     * procedures are separated by the URL tree or the router key they are mounted under, and MCP
     * tool names are one flat namespace per server.
     */
    toolPrefix: z.string(),
  })
  .partial();

/**
 * One affix for every mode, or a per-mode map. Keys match drzl's internal mode names.
 *
 * `pattern` is annotation only: it changes nothing about how this parses, and exists so the
 * generated `drzl.config.schema.json` carries the character half of the affix rule that
 * `z.toJSONSchema` drops along with the `.superRefine` that states it. `validateAffix` remains
 * the enforcing copy, and its message is the one a user sees.
 */
const affixValueSchema = (pattern: string) =>
  z.union(
    [
      z.string().meta({ pattern }),
      z
        .object({
          insert: z.string().meta({ pattern }).optional(),
          update: z.string().meta({ pattern }).optional(),
          select: z.string().meta({ pattern }).optional(),
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
    prefix: affixValueSchema(AFFIX_PREFIX_PATTERN).optional(),
    suffix: affixValueSchema(AFFIX_SUFFIX_PATTERN).optional(),
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

/**
 * Every generator DRZL can run, named once.
 *
 * Extracted from `GeneratorSchema.kind` rather than restated beside it, because three surfaces
 * have to agree about this list and two of them used to spell it themselves: the config parser,
 * the JSON Schema editors validate a `drzl.config.json` against, and the CLI's `--only`. A kind
 * added here is accepted by all three at once, which is the property `--only` needs to be able to
 * refuse an unknown value by name instead of matching nothing in silence.
 */
export const GeneratorKindSchema = z.enum([
  'orpc',
  'trpc',
  'hono',
  'express',
  'fastify',
  'nestjs',
  'graphql',
  'ai',
  'effect-http',
  'h3',
  'mcp',
  'next',
  'tanstack-start',
  'service',
  'zod',
  'valibot',
  'arktype',
  'typebox',
  'effect',
  'json-schema',
]);

/** One generator kind, as the config spells it. */
export type GeneratorKind = z.infer<typeof GeneratorKindSchema>;

/** The kinds in declaration order, for a message that has to list them. */
export const GENERATOR_KINDS: readonly GeneratorKind[] = GeneratorKindSchema.options;

export const GeneratorSchema = z.object({
  kind: GeneratorKindSchema,
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
   * Which generation of the MCP TypeScript SDK the emitted server is written against. `mcp` only.
   *
   * `v2` is `@modelcontextprotocol/server`, which takes any Standard Schema and so works with
   * every library `validation.library` can name. `v1` is `@modelcontextprotocol/sdk`, which is
   * zod-only: handed an arktype or valibot schema it throws at registration, so the generator
   * refuses that combination rather than emitting a server that dies on startup.
   */
  sdk: z.enum(['v1', 'v2']).optional(),
  /**
   * Which h3 major the emitted route handlers are written against. `h3` only.
   *
   * `v1` is the default and is what released Nitro depends on: nitropack 2.13.4 names
   * `h3: ^1.15.11`, while h3's own `latest` tag is a 2.x release candidate. v1 has no Standard
   * Schema overload on its validation helpers, so the emitted modules carry an adapter; v2 takes a
   * schema directly and carries none.
   */
  h3: z.enum(['v1', 'v2']).optional(),
  /** The identifier the assembled `HttpApi` carries. `effect-http` only, defaults to `'api'`. */
  apiName: z.string().optional(),
  /** The name and version the emitted MCP server reports at initialize. `mcp` only. */
  serverName: z.string().optional(),
  serverVersion: z.string().optional(),
  /**
   * Also emit `stdio.ts`, a runnable entry point an MCP client's `command` can point at.
   * `mcp` only, on by default.
   */
  stdio: z.boolean().optional(),
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
    /**
     * Path to the Drizzle schema module. Optional since drizzle-kit interop: a project that
     * already names its schema in `drizzle.config.ts` should not have to say it twice, so an
     * omitted `schema` falls back to reading the drizzle-kit config (see `drizzleKit`). The
     * "neither file names a schema" error is raised at resolution time, where it can name both
     * files, rather than here, where "Required" could name only this one.
     */
    schema: z.string().optional(),
    /**
     * Read the schema path from drizzle-kit's own config instead of `schema`.
     *
     * `true` reads `drizzle.config.ts`, then `.js`, then `.json`, the same candidates in the
     * same order drizzle-kit's CLI uses (measured on drizzle-kit 0.31.10). A string reads that
     * file, wherever it is, like kit's own `--config` flag. `false` disables the fallback, so
     * an omitted `schema` is an error even beside a drizzle.config. Unset behaves like `true`
     * whenever `schema` is omitted, and does nothing when `schema` is set: `schema` always
     * wins, with a warning when both are stated.
     *
     * Only kit's `schema` (string or array, entries may be globs) and `dialect` (cross-checked
     * against what the analyzer detects) are read. Everything else in that file describes
     * migrations and database credentials, which DRZL has no use for.
     */
    drizzleKit: z
      .union([z.boolean(), z.string()], {
        error:
          'Expected true (read drizzle.config.ts/.js/.json, the same candidates drizzle-kit ' +
          'uses), false (never read one), or a path to the drizzle-kit config file.',
      })
      .optional(),
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

/**
 * Every filename `drzl` will load a config from, in the order it tries them.
 *
 * One list because there were two. `computeWatchTargets` carried its own copy of four of these
 * names, and the copy was missing `drzl.config.json`: a JSON config loaded fine, and then
 * `drzl watch` never noticed an edit to it, because nothing was watching the file. The watcher's
 * test spelled the same four names a third time, so it agreed with the bug.
 */
export const CONFIG_FILE_NAMES = [
  'drzl.config.ts',
  'drzl.config.mjs',
  'drzl.config.js',
  'drzl.config.cjs',
  'drzl.config.json',
] as const;

/** Where the published schema answers from, and what `$schema` in a config should point at. */
export const CONFIG_SCHEMA_ID = 'https://use-drzl.github.io/drzl/drzl.config.schema.json';

/**
 * `ConfigSchema` as a JSON Schema, for editors pointed at a `drzl.config.json`.
 *
 * Two things about `z.toJSONSchema` decide the arguments here, both measured rather than assumed:
 *
 *  - `io` defaults to `'output'`, which marks every key carrying a `.default()` as `required`.
 *    That is four of the nine top-level keys, so the default would produce a schema that flags
 *    all 32 configs in the docs and every minimal config a reader writes. `'input'` describes
 *    what a user writes, which is what a config file is.
 *  - refinements are dropped silently. The only one here is the affix `.superRefine`; its
 *    character half is carried by the `pattern` annotations on `affixValueSchema`, and its
 *    collision half cannot be stated in JSON Schema at all and stays a CLI-only error.
 *
 * draft-07 rather than 2020-12 because that is the dialect every editor implements fully, and
 * this schema uses nothing newer.
 */
export function buildConfigJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ConfigSchema, {
    io: 'input',
    target: 'draft-7',
  }) as Record<string, unknown>;

  const properties = {
    // Declared so an editor suggests it and does not report the pointer a reader was told to
    // add as an unknown key. `ConfigSchema` is not strict, so the CLI strips it and never sees it.
    $schema: {
      type: 'string',
      description: 'Path or URL of this schema, for editor completion. Ignored by drzl.',
    },
    ...(generated.properties as Record<string, unknown>),
  };

  // Rebuilt rather than mutated so the key order of the written file is deliberate and stable:
  // a diff of this artefact should show what changed in the config, not a reshuffle.
  const { $schema, properties: _dropped, ...rest } = generated;
  return {
    $schema,
    $id: CONFIG_SCHEMA_ID,
    title: 'DRZL configuration',
    description:
      'Configuration for the drzl CLI. Also describes drzl.config.ts, which gets the same ' +
      'shape from the defineConfig export of @drzl/cli/config.',
    ...rest,
    properties,
  };
}

type GeneratorConfig = DrzlConfig['generators'][number];

/** The generators that emit an RPC router, and so share `outDir` and `validation`. */
/** The generators that import the validation generators' exports by name. */
const ROUTER_KINDS = new Set([
  'orpc',
  'trpc',
  'hono',
  'express',
  'mcp',
  'next',
  'ai',
  'tanstack-start',
  'h3',
  'effect-http',
]);

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

/**
 * Where the NestJS generator writes.
 *
 * The same rule as the five routers, though this one emits DTO modules rather than routes: it
 * still writes an `index.ts` barrel and a `validation.ts` of its own, so a config that runs it
 * beside a router generator has to give at least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records:
 * these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which kind's function is
 * authoritative for which.
 */
export function nestjsOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the GraphQL generator writes.
 *
 * The same rule as the routers and the NestJS kind, though this one emits SDL modules rather
 * than routes: it still writes an `index.ts` barrel and a `scalars.ts` of its own, so a config
 * that runs it beside a router generator has to give at least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir`
 * records: these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which kind's function is
 * authoritative for which.
 */
export function graphqlOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the MCP generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel and a
 * `stdio.ts` of its own, so a config that runs it beside a router generator has to give at least
 * one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records:
 * these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which kind's function is
 * authoritative for which.
 */
export function mcpOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the Next.js generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel and a
 * `form-state.ts` of its own, so a config that runs it beside a router generator has to give at
 * least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records:
 * these are separate decisions that happen to agree today, and a reader following
 * `computeGeneratorOutputDirs` should not have to work out which kind's function is authoritative
 * for which.
 */
export function nextOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the AI SDK generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel of its own,
 * so a config that runs it beside a router generator has to give at least one of them a `path`.
 *
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records.
 */
export function aiOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the TanStack Start generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel of its own.
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records.
 */
export function tanstackStartOutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the h3 generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel of its own.
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records.
 */
export function h3OutDir(g: { path?: string }, cfg: { outDir: string }): string {
  return g.path ?? cfg.outDir;
}

/**
 * Where the Effect HttpApi generator writes.
 *
 * The same rule as the routers, and for the same reason: it writes an `index.ts` barrel of its own.
 * Its own function rather than a call to one of the others, for the reason `honoOutDir` records.
 */
export function effectHttpOutDir(g: { path?: string }, cfg: { outDir: string }): string {
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

    /**
     * The NestJS generator emits DTO classes, not routes, so it belongs to neither set below.
     * It does read `validation.library` (which library the emitted schemas are spelled in), but
     * every other key of that block describes schema *sharing*, and its DTO modules are
     * self-contained on purpose: the class fields are generated from the same columns as the
     * schema, so importing a schema another generator wrote would let the two drift. Each unread
     * option is refused with a warning rather than parsed and dropped, which is the shape of
     * dead option this config has already shipped twice.
     */
    if (g.kind === 'nestjs') {
      if (g.databaseInjection?.enabled) {
        warnings.push(
          `drzl config: the "nestjs" generator sets databaseInjection.enabled, which it does ` +
            `not support. It emits DTO classes with no handlers at all, so nothing reads the ` +
            `injected handle. Reach your database from the controllers you write around these ` +
            `DTOs, or use the "trpc" or "orpc" generator, which do delegate to ` +
            `@drzl/generator-service.`
        );
      }
      if (g.includeRelations) {
        warnings.push(
          `drzl config: the "nestjs" generator sets includeRelations, which it does not read. ` +
            `Relation lookups are routes, and this generator emits DTO classes for your own ` +
            `controllers rather than routes. Remove the flag.`
        );
      }
      if (g.validation?.useShared || g.validation?.importPath) {
        warnings.push(
          `drzl config: the "nestjs" generator sets validation.useShared or ` +
            `validation.importPath, which it does not read. Its DTO modules are ` +
            `self-contained: the class fields and the schema are generated from the same ` +
            `columns, and wrapping a schema another generator wrote would let the two drift. ` +
            `Only validation.library is read on this kind.`
        );
      }
      if (g.validation?.schemaSuffix || g.validation?.affix) {
        warnings.push(
          `drzl config: the "nestjs" generator sets validation.schemaSuffix or ` +
            `validation.affix, which it does not read. Those options spell the names of shared ` +
            `schema modules, and this generator imports none. Only validation.library is read ` +
            `on this kind.`
        );
      }
      continue;
    }

    /**
     * The GraphQL generator emits SDL and resolver stubs, so it belongs to neither set below,
     * and unlike the NestJS kind it reads no `validation` key at all: its schema is GraphQL
     * SDL, GraphQL's own type language, so there is no library to choose and no shared schema
     * module to import. Each unread option is refused with a warning rather than parsed and
     * dropped, which is the shape of dead option this config has already shipped twice.
     */
    if (g.kind === 'graphql') {
      if (g.databaseInjection?.enabled) {
        warnings.push(
          `drzl config: the "graphql" generator sets databaseInjection.enabled, which it does ` +
            `not support. It emits SDL and resolver stubs with no handlers at all, so nothing ` +
            `reads the injected handle. Reach your database from the resolvers you write in ` +
            `place of the stubs, or use the "trpc" or "orpc" generator, which do delegate to ` +
            `@drzl/generator-service.`
        );
      }
      if (g.includeRelations) {
        warnings.push(
          `drzl config: the "graphql" generator sets includeRelations, which it does not ` +
            `read. Relation lookups are routes on the router generators, and relation fields ` +
            `on a GraphQL type are resolvers you write against your own data layer. Remove ` +
            `the flag.`
        );
      }
      if (g.validation) {
        warnings.push(
          `drzl config: the "graphql" generator sets "validation", which it does not read. ` +
            `Its schema is GraphQL SDL, GraphQL's own type language, so there is no library ` +
            `to choose and no shared schema module to import. Remove the block.`
        );
      }
      continue;
    }

    /**
     * The MCP generator, whose one unread option is `includeRelations`.
     *
     * Reported rather than parsed and dropped, which is the shape of dead option this config has
     * already shipped twice. Unlike NestJS and GraphQL above this kind does *not* `continue`: it
     * reads `validation` whole, including `useShared` and `importPath`, which is where the
     * constraint bounds its tools advertise come from, so it goes on to the router reconciliation
     * below like every other kind that imports a sibling generator's exports.
     */
    /**
     * The TanStack Start generator, which has the same single mode as `next`: it emits no schemas
     * of its own, so `tanstackStartOptions` turns `useShared` on and derives the import path.
     */
    /**
     * The h3 generator, which has the same single mode as `next` and `tanstack-start`: it emits no
     * schemas of its own, so its options builder turns `useShared` on and derives the import path.
     */
    /**
     * The Effect HttpApi generator, whose sibling is always the `effect` one: `HttpApi` declares
     * its payloads as Effect Schema and takes nothing else, so there is no library to choose.
     */
    if (g.kind === 'effect-http') {
      // `validation.library` is not even offered for this kind: the enum lists the three libraries
      // a *validator* generator emits, and `effect` is not among them because HttpApi is the only
      // consumer of Effect Schema here. So any value set on this kind is one that cannot be
      // honoured, and the builder overrides it, which is the dead-option shape this config reports
      // rather than accepts.
      if (g.validation?.library) {
        warnings.push(
          `drzl config: the "effect-http" generator sets validation.library, which it does not ` +
            `read. HttpApi declares its payloads as Effect Schema and takes nothing else, so ` +
            `there is no library to choose. Remove the key.`
        );
      }
      if (!g.validation?.importPath && !generators.some((s) => s.kind === 'effect')) {
        warnings.push(
          `drzl config: the "effect-http" generator declares the Effect Schema modules a ` +
            `validation generator writes, and this config has no "effect" generator for it to ` +
            `import from. Add { kind: "effect" }, or set validation.importPath to wherever those ` +
            `schemas live.`
        );
      }
    }

    if (g.kind === 'h3') {
      if (g.includeRelations) {
        warnings.push(
          `drzl config: the "h3" generator sets includeRelations, which it does not read yet. ` +
            `Relation lookups are a route this generator does not emit. Remove the flag.`
        );
      }
      const library = g.validation?.library ?? 'zod';
      if (!g.validation?.importPath && !generators.some((s) => s.kind === library)) {
        warnings.push(
          `drzl config: the "h3" generator validates with the schemas a validation generator ` +
            `writes, and this config has no "${library}" generator for it to import from. Add ` +
            `{ kind: "${library}" }, or set validation.importPath to wherever those schemas live.`
        );
      }
    }

    if (g.kind === 'tanstack-start') {
      if (g.includeRelations) {
        warnings.push(
          `drzl config: the "tanstack-start" generator sets includeRelations, which it does not ` +
            `read. Relation lookups are routes, and this generator emits server functions. ` +
            `Remove the flag.`
        );
      }
      const library = g.validation?.library ?? 'zod';
      if (!g.validation?.importPath && !generators.some((s) => s.kind === library)) {
        warnings.push(
          `drzl config: the "tanstack-start" generator validates with the schemas a validation ` +
            `generator writes, and this config has no "${library}" generator for it to import ` +
            `from. Add { kind: "${library}" }, or set validation.importPath to wherever those ` +
            `schemas live.`
        );
      }
    }

    if (g.kind === 'ai' && g.includeRelations) {
      warnings.push(
        `drzl config: the "ai" generator sets includeRelations, which it does not read. ` +
          `Relation lookups are routes, and this generator emits AI SDK tools rather than routes. ` +
          `Remove the flag.`
      );
    }

    if (g.kind === 'mcp' && g.includeRelations) {
      warnings.push(
        `drzl config: the "mcp" generator sets includeRelations, which it does not read. ` +
          `Relation lookups are routes, and this generator emits MCP tools rather than routes. ` +
          `Remove the flag.`
      );
    }

    /**
     * The Next.js generator, whose unread option is the same one.
     *
     * `validation.useShared` is not warned about when it is absent, unlike every other kind: this
     * generator emits no schemas of its own, so shared is its only mode and the CLI turns it on.
     * What it does need is a validation generator in the same config to import from, and that is
     * reported here rather than left to a failed import in the emitted tree.
     */
    if (g.kind === 'next') {
      if (g.includeRelations) {
        warnings.push(
          `drzl config: the "next" generator sets includeRelations, which it does not read. ` +
            `Relation lookups are routes, and this generator emits server actions that parse a ` +
            `posted form. Remove the flag.`
        );
      }
      const library = g.validation?.library ?? 'zod';
      if (!g.validation?.importPath && !generators.some((s) => s.kind === library)) {
        warnings.push(
          `drzl config: the "next" generator parses the schemas a validation generator writes, ` +
            `and this config has no "${library}" generator for it to import from. Add ` +
            `{ kind: "${library}" }, or set validation.importPath to wherever those schemas live.`
        );
      }
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
 * `ConfigSchema` as a JSON Schema, once, for the two things that read it back.
 *
 * Rebuilt on every call it would cost about 0.7ms, which is nothing for `generate` and is paid on
 * every rebuild of a `watch` that may run for a day. Held apart from `buildConfigJsonSchema`
 * itself so the exported function keeps handing every caller a fresh object it may write to; this
 * one is only ever read.
 */
let configShape: Record<string, unknown> | null = null;
function configShapeForReading(): Record<string, unknown> {
  return (configShape ??= buildConfigJsonSchema());
}

/**
 * How the config file is named in a message: relative to where the command was run, unless that
 * would be a walk back up out of it, which says less than the path itself.
 */
function displayConfigPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') ? relative : file;
}

/**
 * Parse, report, then resolve cross-generator defaults. Both `generate` and `watch` go through
 * loadConfig, so putting the resolution here is what keeps the two duplicated generator
 * dispatch blocks in cli.ts from needing the logic twice.
 *
 * `safeParse` rather than `parse`, because the thrown `ZodError`'s message is a formatted JSON
 * array of issue objects and that array is what the CLI used to print (item 78). The issues
 * themselves carry the key path; only the rendering was missing.
 *
 * Unknown keys are reported after the parse succeeds and not before (item 79). A config that does
 * not parse has a failure to fix first, and listing the keys that would have been dropped from a
 * config nobody can load yet is noise under an error.
 */
function finalize(raw: unknown, file: string, onWarn: (warning: string) => void): DrzlConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(
      formatConfigProblems(
        displayConfigPath(file),
        parsed.error.issues,
        raw,
        configShapeForReading()
      )
    );
  }
  for (const w of unknownKeyWarnings(raw, configShapeForReading())) onWarn(w);
  // A config with no `generators` key gets oRPC routers, which is a whole API surface arriving
  // from a default nobody typed. Someone who came for validators and wrote the smallest config
  // that parses gets a router tree and no hint of where it came from.
  //
  // Said rather than changed. Both ways of removing the surprise, requiring the key or defaulting
  // to zod, change what an existing config does, and that belongs with a major rather than with a
  // patch. What does not have to wait is the silence: the default is now named where it applies,
  // with the choices beside it. Read off `raw`, because the parsed config cannot tell a key that
  // was absent from one that was written out.
  if (raw && typeof raw === 'object' && !('generators' in (raw as Record<string, unknown>))) {
    onWarn(
      `drzl config: no "generators" key, so this run uses the default, [{ kind: 'orpc' }], and ` +
        `writes an oRPC router tree. Name the key to choose: "zod", "valibot", "arktype", ` +
        `"typebox", "effect" and "json-schema" emit validation schemas, "orpc", "trpc", "hono", ` +
        `"express", "fastify", "nestjs" and "graphql" emit an API surface, and "service" emits ` +
        `typed data-access stubs.`
    );
  }
  const { config, warnings } = resolveConfig(parsed.data);
  for (const w of warnings) onWarn(w);
  return config;
}

/**
 * Load a config module fresh from disk: JSON parsed directly, everything else through jiti
 * with cache-busting, exactly as `loadConfig` always has.
 *
 * Extracted so the drizzle-kit interop reads `drizzle.config.ts` through the same loader that
 * reads `drzl.config.ts`, rather than through a second dependency or a second set of jiti
 * options that could drift from this one.
 */
export async function importFreshConfigModule(p: string): Promise<unknown> {
  const fsp = await import('node:fs/promises');
  const ext = path.extname(p).toLowerCase();

  // JSON: read directly
  if (ext === '.json') {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
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
  return mod?.default ?? mod;
}

/**
 * The config, or `null` when there is none.
 *
 * `onWarn` exists so the config's warnings reach the output layer rather than the process. They
 * went to `console.warn` until now, which is stderr with no route through `--quiet` or `--json`:
 * `drzl generate --json` printed them beside the document it promises is the only thing on
 * stdout's channel, and `--quiet` could not remove them. Item 79 adds a warning to exactly this
 * path, so the path is fixed here rather than gaining a second writer that bypasses `Output`.
 *
 * The default keeps the old behaviour for any caller that has no output layer to hand.
 */
export async function loadConfig(
  customPath?: string,
  onWarn: (warning: string) => void = (warning) => console.warn(warning)
): Promise<DrzlConfig | null> {
  const fsp = await import('node:fs/promises');

  const candidates = customPath ? [customPath] : [...CONFIG_FILE_NAMES];

  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    try {
      await fsp.access(p);
    } catch {
      continue;
    }
    return finalize(await importFreshConfigModule(p), p, onWarn);
  }

  return null;
}

/**
 * A config nobody wrote to a file, built from what the command line said.
 *
 * `drzl generate --schema src/db/schema.ts --only orpc` is the config route with the config
 * inlined, and it is what replaces the two per-kind commands: those took a schema path and a kind
 * and could reach none of the config's features, because they had no config at all. This produces
 * a real one, so everything downstream, the filters, the naming, the write plan, `--check`, is the
 * same code reading the same shape whether the config came from disk or from two flags.
 *
 * Through `ConfigSchema` and `resolveConfig` rather than by hand, and that is the whole point: the
 * defaults a config file gets are applied here too, `importExtension` is pushed down onto each
 * generator exactly as it is for a file, and a hand-built object that skipped either would emit
 * different bytes from the equivalent config for no reason a user could see.
 *
 * `schema` may be omitted, in which case the drizzle-kit config answers for it, exactly as it does
 * for a `drzl.config.ts` with no `schema` key.
 */
export function configFromKinds(
  kinds: readonly GeneratorKind[],
  schema?: string,
  onWarn: (warning: string) => void = () => {}
): DrzlConfig {
  const parsed = ConfigSchema.parse({
    ...(schema ? { schema } : {}),
    generators: kinds.map((kind) => ({ kind })),
  });
  const { config, warnings } = resolveConfig(parsed);
  for (const w of warnings) onWarn(w);
  return config;
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
    if (g.kind === 'nestjs') dirs.add(abs(nestjsOutDir(g, cfg)));
    if (g.kind === 'graphql') dirs.add(abs(graphqlOutDir(g, cfg)));
    if (g.kind === 'mcp') dirs.add(abs(mcpOutDir(g, cfg)));
    if (g.kind === 'next') dirs.add(abs(nextOutDir(g, cfg)));
    if (g.kind === 'ai') dirs.add(abs(aiOutDir(g, cfg)));
    if (g.kind === 'tanstack-start') dirs.add(abs(tanstackStartOutDir(g, cfg)));
    if (g.kind === 'h3') dirs.add(abs(h3OutDir(g, cfg)));
    if (g.kind === 'effect-http') dirs.add(abs(effectHttpOutDir(g, cfg)));
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

export function computeWatchTargets(
  cfg: DrzlConfig,
  cwd = process.cwd(),
  source?: import('./drizzle-kit.js').ResolvedSchemaSource
): string[] {
  const abs = (p: string) => path.resolve(cwd, p);
  // Directories and files only, never globs. Chokidar removed glob support in v4 and treats
  // `<dir>/**/*.{ts,tsx,js}` as a literal path, so it watched a directory named `**` that does
  // not exist: no event ever fired and `drzl watch` did its initial build and then sat inert.
  // A directory is watched recursively by chokidar itself, and the extension filtering that the
  // glob was doing now happens on the event instead.
  const targets = new Set<string>(CONFIG_FILE_NAMES.map(abs));
  if (source) {
    // The resolved source's directories cover both shapes: the drzl `schema` file's directory,
    // or every directory the drizzle-kit config's entries live in (glob bases included, so a
    // file created later that matches the glob still raises an event). The drizzle-kit config
    // file itself is watched too: editing it changes which files are the schema, and a watcher
    // not watching it would keep generating from the old set forever.
    for (const d of source.watchDirs) targets.add(abs(d));
    if (source.drizzleKitConfigPath) targets.add(abs(source.drizzleKitConfigPath));
  } else if (cfg.schema) {
    targets.add(path.dirname(abs(cfg.schema)));
  }
  for (const t of resolveTemplateDirsSync(cfg, cwd)) targets.add(t);
  return [...targets];
}
