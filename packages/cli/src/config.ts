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
  // zod generator specific options
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
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const candidates = customPath
    ? [customPath]
    : ['drzl.config.ts', 'drzl.config.mjs', 'drzl.config.js', 'drzl.config.json'];

  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    try {
      await fs.access(p);
    } catch {
      continue;
    }

    // JSON path — parse directly
    if (/\.json$/i.test(p)) {
      try {
        const content = await fs.readFile(p, 'utf8');
        const raw = JSON.parse(content);
        return ConfigSchema.parse(raw); // -> DrzlConfig (output)
      } catch (e2) {
        throw new Error(`Failed to load config from ${p}: ${String(e2)}`);
      }
    }

    // TS/ESM/CJS via jiti
    try {
      const { createJiti } = await import('jiti');
      const jit = createJiti(import.meta.url);
      const mod = await jit.import(p);
      const raw = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
      return ConfigSchema.parse(raw); // parse to resolved output
    } catch (e) {
      console.error(`jiti failed to load ${p}:`, e);
      // Fallback: try JSON parse
      try {
        const content = await fs.readFile(p, 'utf8');
        const raw = JSON.parse(content);
        return ConfigSchema.parse(raw);
      } catch (e2) {
        throw new Error(`Failed to load config from ${p}: ${String(e2)}`);
      }
    }
  }
  return null;
}
