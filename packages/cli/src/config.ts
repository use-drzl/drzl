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

export const GeneratorSchema = z.object({
  kind: z.enum(['orpc', 'service', 'zod', 'valibot', 'arktype']),
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
  // orpc validation sharing
  validation: z
    .object({
      useShared: z.boolean().default(false).optional(),
      library: z.enum(['zod', 'valibot', 'arktype']).default('zod').optional(),
      importPath: z.string().optional(),
      schemaSuffix: z.string().optional(),
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

export const ConfigSchema = z.object({
  schema: z.string(),
  outDir: z.string().default('src/api'),
  analyzer: AnalyzerSchema.default({
    includeRelations: true,
    validateConstraints: true,
    includeHeuristicRelations: false,
  }),
  generators: z
    .array(GeneratorSchema)
    .min(1)
    .default([{ kind: 'orpc' } as any]),
});

// ✨ Separate input vs output types
export type DrzlConfigInput = z.input<typeof ConfigSchema>;
export type DrzlConfig = z.output<typeof ConfigSchema>;

export function defineConfig<T extends DrzlConfigInput>(cfg: T): T {
  return cfg;
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
      return ConfigSchema.parse(raw);
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
      tryNative: false, // <— prevent native import of .ts
      // debug: true,
    }) as any;

    const mod = await jiti.import(p);
    const raw = mod?.default ?? mod;
    return ConfigSchema.parse(raw);
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
  const targets = new Set<string>([
    path.join(path.dirname(schemaAbs), '**/*.{ts,tsx,js}'),
    abs('drzl.config.ts'),
    abs('drzl.config.js'),
    abs('drzl.config.mjs'),
    abs('drzl.config.cjs'),
  ]);
  for (const t of resolveTemplateDirsSync(cfg, cwd)) targets.add(t);
  return [...targets];
}
