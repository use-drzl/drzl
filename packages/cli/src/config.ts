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
  kind: z.enum(['orpc', 'service', 'zod', 'valibot', 'arktype']),
  /**
   * Overrides the top-level `importExtension` for this generator alone, for a project whose
   * generated directories are compiled by different tsconfigs.
   */
  importExtension: ImportExtensionSchema.optional(),
  template: z.string().optional(),
  includeRelations: z.boolean().optional(),
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
  // orpc validation sharing
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
    if (g.kind !== 'orpc') continue;
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
          `drzl config: the "orpc" generator's validation.schemaSuffix ` +
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
        `drzl config: the "orpc" generator imports shared ${library} schemas, but its ` +
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
    if (g.kind === 'service') dirs.add(abs(g.path ?? 'src/services'));
    if (g.kind === 'zod') dirs.add(abs(g.path ?? 'src/validators/zod'));
    if (g.kind === 'valibot') dirs.add(abs(g.path ?? 'src/validators/valibot'));
    if (g.kind === 'arktype') dirs.add(abs(g.path ?? 'src/validators/arktype'));
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
    if (!t || t === 'standard' || t === 'minimal') continue;

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
