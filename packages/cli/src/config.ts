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

export const ConfigSchema = z.object({
  schema: z.string(),
  outDir: z.string().default('src/api'),
  analyzer: z
    .object({
      includeRelations: z.boolean().default(true),
      validateConstraints: z.boolean().default(true),
      includeHeuristicRelations: z.boolean().default(false),
    })
    .default({
      includeRelations: true,
      validateConstraints: true,
      includeHeuristicRelations: false,
    }),
  generators: z
    .array(GeneratorSchema)
    .min(1)
    .default([{ kind: 'orpc' } as any]),
});

export type DrzlConfig = z.infer<typeof ConfigSchema>;

export function defineConfig(cfg: DrzlConfig) {
  return cfg;
}

export async function loadConfig(customPath?: string): Promise<DrzlConfig | null> {
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const candidates = customPath
    ? [customPath]
    : ['drzl.config.ts', 'drzl.config.mjs', 'drzl.config.js'];

  for (const c of candidates) {
    const p = path.resolve(process.cwd(), c);
    try {
      await fs.access(p);
    } catch {
      continue;
    }
    // If JSON, parse directly and skip module loading
    if (/\.json$/i.test(p)) {
      try {
        const content = await fs.readFile(p, 'utf8');
        const raw = JSON.parse(content);
        const parsed = ConfigSchema.parse(raw);
        return parsed;
      } catch (e2) {
        throw new Error(`Failed to load config from ${p}: ${String(e2)}`);
      }
    }
    // Try jiti to seamlessly load TS/ESM/CJS
    try {
      const { default: jiti } = await import('jiti');
      const jit = (jiti as any)(import.meta.url);
      const mod = jit(p);
      const raw = mod && typeof mod === 'object' && 'default' in mod ? (mod as any).default : mod;
      const parsed = ConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return parsed.data;
    } catch (e) {
      // Fallback: try JSON parse
      try {
        const content = await fs.readFile(p, 'utf8');
        const raw = JSON.parse(content);
        const parsed = ConfigSchema.parse(raw);
        return parsed;
      } catch (e2) {
        throw new Error(`Failed to load config from ${p}: ${String(e2)}`);
      }
    }
  }
  return null;
}
