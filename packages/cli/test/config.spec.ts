import { describe, it, expect } from 'vitest';
import {
  computeGeneratorOutputDirs,
  ConfigSchema,
  defineConfig,
  expressOutDir,
  fastifyOutDir,
  graphqlOutDir,
  mcpOutDir,
  nextOutDir,
  loadConfig,
  nestjsOutDir,
  resolveConfig,
  trpcOutDir,
} from '../src/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('@drzl/cli config', () => {
  it('defineConfig returns shape', () => {
    const cfg = defineConfig({
      schema: 'x',
      generators: [{ kind: 'orpc' }],
      outDir: 'out',
      analyzer: { includeRelations: true, validateConstraints: true },
    } as any);
    expect(cfg.schema).toBe('x');
  });

  it('loadConfig reads JSON and applies defaults', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-cli-'));
    const tmp = path.join(tmpDir, 'tmp.config.json');
    try {
      await fs.writeFile(
        tmp,
        JSON.stringify({ schema: 'x', generators: [{ kind: 'orpc' }] }),
        'utf8'
      );
      const cfg = await loadConfig(tmp);
      expect(cfg?.analyzer?.includeRelations).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('@drzl/cli config meta', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('keeps the boolean shorthand and the object form through parse', () => {
    const shorthand: any = ConfigSchema.parse(base([{ kind: 'zod', meta: true }]));
    expect(shorthand.generators[0].meta).toBe(true);
    const full: any = ConfigSchema.parse(base([{ kind: 'zod', meta: { description: true } }]));
    expect(full.generators[0].meta).toEqual({ description: true });
  });

  it('refuses a key it does not know, rather than dropping it in silence', () => {
    // The failure this guards is the one the repository has already had twice: a documented option
    // parses, is stripped, and the feature does nothing while nothing says so.
    expect(() =>
      ConfigSchema.parse(base([{ kind: 'zod', meta: { descriptions: true } }]))
    ).toThrow();
  });
});

describe('@drzl/cli config constraints', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('keeps the boolean shorthand and the object form through parse', () => {
    const shorthand: any = ConfigSchema.parse(base([{ kind: 'zod', constraints: true }]));
    expect(shorthand.generators[0].constraints).toBe(true);
    const full: any = ConfigSchema.parse(
      base([{ kind: 'valibot', constraints: { errorMap: false } }])
    );
    expect(full.generators[0].constraints).toEqual({ errorMap: false });
  });

  it('refuses a key it does not know, rather than dropping it in silence', () => {
    expect(() =>
      ConfigSchema.parse(base([{ kind: 'zod', constraints: { errorMaps: false } }]))
    ).toThrow();
  });
});

describe('@drzl/cli config affix', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('keeps affix through ConfigSchema.parse instead of silently stripping it', () => {
    // The exact block from use-drzl/drzl#16.
    const parsed = ConfigSchema.parse(
      base([
        {
          kind: 'zod',
          path: './src/libs/types/zod',
          affix: {
            tableCase: 'pascal',
            schema: { suffix: 'Schema' },
            type: {
              suffix: { insert: 'Input', update: 'Input', select: 'Output' },
              prefix: { insert: 'Create', update: 'Edit', select: 'Get' },
            },
          },
        },
      ])
    );
    expect(parsed.generators[0].affix).toEqual({
      tableCase: 'pascal',
      schema: { suffix: 'Schema' },
      type: {
        suffix: { insert: 'Input', update: 'Input', select: 'Output' },
        prefix: { insert: 'Create', update: 'Edit', select: 'Get' },
      },
    });
  });

  it('keeps validation.affix on an orpc generator', () => {
    const parsed = ConfigSchema.parse(
      base([
        {
          kind: 'orpc',
          validation: {
            useShared: true,
            library: 'zod',
            importPath: '../validators/zod',
            affix: { tableCase: 'pascal' },
          },
        },
      ])
    );
    expect(parsed.generators[0].validation?.affix).toEqual({ tableCase: 'pascal' });
  });

  it('rejects an affix that would emit an invalid identifier', () => {
    const res = ConfigSchema.safeParse(
      base([{ kind: 'zod', affix: { schema: { suffix: 'my-schema' } } }])
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path.join('.')).toBe('generators.0.affix.schema.suffix');
    }
  });

  it('rejects capitalised mode keys with a message that names the right ones', () => {
    // The issue proposed { Insert: ..., Update: ..., Select: ... }. drzl uses the lowercase
    // mode names everywhere else, so say so instead of silently dropping the block.
    const res = ConfigSchema.safeParse(
      base([{ kind: 'zod', affix: { type: { prefix: { Insert: 'Create' } } } }])
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues[0];
      expect(issue.path.join('.')).toBe('generators.0.affix.type.prefix');
      expect(issue.message).toMatch(/"insert", "update" and "select"/);
    }
  });

  it('rejects an unknown key inside affix instead of ignoring it', () => {
    const res = ConfigSchema.safeParse(
      base([{ kind: 'zod', affix: { tableCase: 'pascal', typo: 1 } }])
    );
    expect(res.success).toBe(false);
  });

  it('rejects an affix that makes two exported schema names collide', () => {
    const res = ConfigSchema.safeParse(
      base([{ kind: 'zod', affix: { schema: { prefix: '', suffix: '' } } }])
    );
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /collide/i.test(i.message))).toBe(true);
    }
  });

  it('accepts an affix that strips prefix and suffix for a single mode', () => {
    const res = ConfigSchema.safeParse(
      base([
        {
          kind: 'zod',
          affix: { tableCase: 'pascal', type: { prefix: { select: '' }, suffix: { select: '' } } },
        },
      ])
    );
    expect(res.success).toBe(true);
  });

  it('gives an orpc generator the sibling validation generator affix when it has none', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'zod', affix: { tableCase: 'pascal', schema: { suffix: 'Doc' } } },
        {
          kind: 'orpc',
          validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
        },
      ])
    );
    const { config, warnings } = resolveConfig(parsed);
    const orpc = config.generators.find((g) => g.kind === 'orpc')!;
    expect(orpc.validation?.affix?.tableCase).toBe('pascal');
    expect(orpc.validation?.affix?.schema?.suffix).toEqual({
      insert: 'Doc',
      update: 'Doc',
      select: 'Doc',
    });
    expect(warnings).toEqual([]);
  });

  it('does not inherit across libraries', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'valibot', affix: { tableCase: 'pascal' } },
        {
          kind: 'orpc',
          validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
        },
      ])
    );
    const { config } = resolveConfig(parsed);
    const orpc = config.generators.find((g) => g.kind === 'orpc')!;
    expect(orpc.validation?.affix).toBeUndefined();
  });

  it('throws when an explicit orpc affix disagrees with the sibling it imports from', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'zod', affix: { schema: { suffix: 'Doc' } } },
        {
          kind: 'orpc',
          validation: {
            useShared: true,
            library: 'zod',
            importPath: '../validators/zod',
            affix: { schema: { suffix: 'Validator' } },
          },
        },
      ])
    );
    expect(() => resolveConfig(parsed)).toThrow(/InsertusersDoc/);
  });

  it('throws when an explicit orpc affix disagrees with the sibling legacy schemaSuffix', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'zod', schemaSuffix: 'Doc' },
        {
          kind: 'orpc',
          validation: {
            useShared: true,
            library: 'zod',
            importPath: '../validators/zod',
            affix: { schema: { suffix: 'Validator' } },
          },
        },
      ])
    );
    expect(() => resolveConfig(parsed)).toThrow(/disagree/i);
  });

  it('warns but does not rewrite a pre-existing legacy schemaSuffix disagreement', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'zod', schemaSuffix: 'Validator' },
        {
          kind: 'orpc',
          validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
        },
      ])
    );
    const { config, warnings } = resolveConfig(parsed);
    const orpc = config.generators.find((g) => g.kind === 'orpc')!;
    // Byte-for-byte unchanged: no affix invented, no schemaSuffix copied over.
    expect(orpc.validation?.affix).toBeUndefined();
    expect(orpc.validation?.schemaSuffix).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/schemaSuffix/);
  });

  it('leaves the naming of a legacy config untouched', () => {
    const parsed = ConfigSchema.parse(
      base([
        { kind: 'zod' },
        {
          kind: 'orpc',
          validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
        },
      ])
    );
    const before = JSON.parse(JSON.stringify(parsed));
    const { config, warnings } = resolveConfig(parsed);
    // `importExtension` is the one key resolveConfig stamps onto every generator, so that
    // each of them can read the effective value without knowing the top-level default.
    // Nothing to do with naming, and it is already present on `parsed` at the top level.
    const withoutExtension = (cfg: unknown) =>
      JSON.parse(
        JSON.stringify(cfg, (key, value) => (key === 'importExtension' ? undefined : value))
      );
    expect(withoutExtension(config)).toEqual(withoutExtension(before));
    expect(config.generators.map((g) => g.importExtension)).toEqual(['js', 'js']);
    expect(warnings).toEqual([]);
  });
});

describe('@drzl/cli config: the trpc generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'trpc' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'trpc' }]), outDir: 'src/api' });
    expect(trpcOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'trpc', path: 'src/trpc' }]),
      outDir: 'src/api',
    });
    expect(trpcOutDir(withPath.generators[0], withPath)).toBe('src/trpc');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    // The watcher ignores every generator's output directory. A tRPC directory missing from that
    // list is an infinite regeneration loop, not a cosmetic omission.
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'trpc', path: 'src/trpc' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/trpc'));
  });

  it('inherits the sibling validation generator affix, exactly as orpc does', () => {
    const { config } = resolveConfig(
      ConfigSchema.parse(
        base([
          { kind: 'zod', affix: { tableCase: 'pascal' } },
          {
            kind: 'trpc',
            validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
          },
        ])
      )
    );
    const trpc = config.generators.find((g) => g.kind === 'trpc')!;
    expect(trpc.validation?.affix?.tableCase).toBe('pascal');
  });

  it('refuses an affix that disagrees with the generator it imports from', () => {
    expect(() =>
      resolveConfig(
        ConfigSchema.parse(
          base([
            { kind: 'zod', affix: { tableCase: 'pascal' } },
            {
              kind: 'trpc',
              validation: {
                useShared: true,
                library: 'zod',
                importPath: '../validators/zod',
                affix: { tableCase: 'preserve' },
              },
            },
          ])
        )
      )
    ).toThrow(/"trpc" generator imports shared zod schemas/);
  });

  it('pushes databaseInjection onto the service generator that has to match it', () => {
    // A router in injection mode calls `Service.getById(ctx.db, id)`. Declaring the block twice is
    // how the two halves drift into a project that compiles separately and not together.
    const { config, warnings } = resolveConfig(
      ConfigSchema.parse(
        base([
          { kind: 'service', dataAccess: 'drizzle', schemaImportPath: 'src/db/schema' },
          {
            kind: 'trpc',
            template: 'service',
            databaseInjection: { enabled: true, databaseType: 'Database' },
          },
        ])
      )
    );
    const service = config.generators.find((g) => g.kind === 'service')!;
    expect(service.databaseInjection).toEqual({ enabled: true, databaseType: 'Database' });
    expect(warnings).toEqual([]);
  });

  it('says so when injection is asked of a service generator that emits stubs', () => {
    // `@drzl/generator-service` honours the flag only while emitting real Drizzle queries. Its
    // stub bodies take no database parameter whatever they are told, so the router's calls would
    // not compile.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([
          { kind: 'service' },
          { kind: 'trpc', template: 'service', databaseInjection: { enabled: true } },
        ])
      )
    );
    expect(warnings.join('\n')).toMatch(/emits stub bodies/);
  });

  it('keeps databaseInjection through a parse, rather than stripping it in silence', () => {
    // It was documented on the oRPC generator and absent from this schema, so zod dropped the key
    // and the option did nothing at all when set from a config file.
    const parsed = ConfigSchema.parse(
      base([
        {
          kind: 'orpc',
          databaseInjection: {
            enabled: true,
            databaseType: 'Database',
            databaseTypeImport: { name: 'Database', from: 'src/db/db' },
          },
        },
      ])
    );
    expect(parsed.generators[0].databaseInjection?.databaseTypeImport?.from).toBe('src/db/db');
  });
});

describe('@drzl/cli config: the express generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'express' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'express' }]), outDir: 'src/api' });
    expect(expressOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'express', path: 'src/routes' }]),
      outDir: 'src/api',
    });
    expect(expressOutDir(withPath.generators[0], withPath)).toBe('src/routes');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    // The watcher ignores every generator's output directory. An Express directory missing from
    // that list is an infinite regeneration loop, not a cosmetic omission.
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'express', path: 'src/routes' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/routes'));
  });

  it('inherits the sibling validation generator affix, exactly as the other routers do', () => {
    const { config } = resolveConfig(
      ConfigSchema.parse(
        base([
          { kind: 'zod', affix: { tableCase: 'pascal' } },
          {
            kind: 'express',
            validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
          },
        ])
      )
    );
    const express = config.generators.find((g) => g.kind === 'express')!;
    expect(express.validation?.affix?.tableCase).toBe('pascal');
  });

  it('refuses databaseInjection with a warning, because nothing would read the handle', () => {
    // Injection is a contract with @drzl/generator-service, and these handlers are stubs that
    // never call a service. Same refusal as the hono kind.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'express', databaseInjection: { enabled: true } }]))
    );
    expect(warnings.join('\n')).toMatch(/"express" generator sets databaseInjection/);
    expect(warnings.join('\n')).toMatch(/does not support/);
  });
});

describe('@drzl/cli config: the fastify generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'fastify' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'fastify' }]), outDir: 'src/api' });
    expect(fastifyOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'fastify', path: 'src/routes' }]),
      outDir: 'src/api',
    });
    expect(fastifyOutDir(withPath.generators[0], withPath)).toBe('src/routes');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    // The watcher ignores every generator's output directory. A Fastify directory missing from
    // that list is an infinite regeneration loop, not a cosmetic omission.
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'fastify', path: 'src/routes' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/routes'));
  });

  it('refuses databaseInjection with a warning, because nothing would read the handle', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'fastify', databaseInjection: { enabled: true } }]))
    );
    expect(warnings.join('\n')).toMatch(/"fastify" generator sets databaseInjection/);
    expect(warnings.join('\n')).toMatch(/does not support/);
  });

  it('refuses a validation block with a warning, because nothing would read it', () => {
    // Unlike the other routers there is no library to choose and no shared module to import:
    // the schemas are JSON Schema from the same builder as the json-schema generator, inlined.
    // An accepted-and-ignored option is the dead-option shape this config has shipped twice.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'fastify', validation: { useShared: true, importPath: 'v' } }])
      )
    );
    expect(warnings.join('\n')).toMatch(/"fastify" generator sets "validation"/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('does not warn on a plain fastify generator', () => {
    const { warnings } = resolveConfig(ConfigSchema.parse(base([{ kind: 'fastify' }])));
    expect(warnings).toEqual([]);
  });
});

describe('@drzl/cli config: the nestjs generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'nestjs' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'nestjs' }]), outDir: 'src/api' });
    expect(nestjsOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'nestjs', path: 'src/dto' }]),
      outDir: 'src/api',
    });
    expect(nestjsOutDir(withPath.generators[0], withPath)).toBe('src/dto');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    // The watcher ignores every generator's output directory. A DTO directory missing from
    // that list is an infinite regeneration loop, not a cosmetic omission.
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'nestjs', path: 'src/dto' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/dto'));
  });

  it('refuses databaseInjection with a warning, because there are no handlers at all', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'nestjs', databaseInjection: { enabled: true } }]))
    );
    expect(warnings.join('\n')).toMatch(/"nestjs" generator sets databaseInjection/);
    expect(warnings.join('\n')).toMatch(/does not support/);
  });

  it('refuses includeRelations with a warning, because relation lookups are routes', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'nestjs', includeRelations: true }]))
    );
    expect(warnings.join('\n')).toMatch(/"nestjs" generator sets includeRelations/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('refuses the validation sharing keys with a warning, and reads library alone', () => {
    // The DTO modules are self-contained: class fields and schema come from the same columns,
    // so a shared schema module would let the two drift. Only library is read.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'nestjs', validation: { useShared: true, importPath: 'v' } }])
      )
    );
    expect(warnings.join('\n')).toMatch(/"nestjs" generator sets validation\.useShared/);
    const affixed = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'nestjs', validation: { schemaSuffix: 'Schema' } }])
      )
    );
    expect(affixed.warnings.join('\n')).toMatch(/"nestjs" generator sets validation\.schemaSuffix/);
  });

  it('does not warn on a plain nestjs generator, nor on a chosen library', () => {
    const { warnings } = resolveConfig(ConfigSchema.parse(base([{ kind: 'nestjs' }])));
    expect(warnings).toEqual([]);
    const chosen = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'nestjs', validation: { library: 'valibot' } }]))
    );
    expect(chosen.warnings).toEqual([]);
  });
});

describe('@drzl/cli config: the graphql generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'graphql' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'graphql' }]), outDir: 'src/api' });
    expect(graphqlOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'graphql', path: 'src/graphql' }]),
      outDir: 'src/api',
    });
    expect(graphqlOutDir(withPath.generators[0], withPath)).toBe('src/graphql');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    // The watcher ignores every generator's output directory. An SDL directory missing from
    // that list is an infinite regeneration loop, not a cosmetic omission.
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'graphql', path: 'src/graphql' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/graphql'));
  });

  it('refuses databaseInjection with a warning, because there are no handlers at all', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'graphql', databaseInjection: { enabled: true } }]))
    );
    expect(warnings.join('\n')).toMatch(/"graphql" generator sets databaseInjection/);
    expect(warnings.join('\n')).toMatch(/does not support/);
  });

  it('refuses includeRelations with a warning, because relation lookups are routes', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'graphql', includeRelations: true }]))
    );
    expect(warnings.join('\n')).toMatch(/"graphql" generator sets includeRelations/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('refuses a validation block with a warning, because SDL is its own type language', () => {
    // Unlike the nestjs kind there is no library key to read either: the emitted schema is
    // GraphQL SDL, so there is nothing for zod, valibot or arktype to say. An
    // accepted-and-ignored option is the dead-option shape this config has shipped twice.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'graphql', validation: { library: 'valibot' } }]))
    );
    expect(warnings.join('\n')).toMatch(/"graphql" generator sets "validation"/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('does not warn on a plain graphql generator', () => {
    const { warnings } = resolveConfig(ConfigSchema.parse(base([{ kind: 'graphql' }])));
    expect(warnings).toEqual([]);
  });
});

describe('@drzl/cli config: the mcp generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'mcp' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'mcp' }]), outDir: 'src/api' });
    expect(mcpOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'mcp', path: 'src/mcp' }]),
      outDir: 'src/api',
    });
    expect(mcpOutDir(withPath.generators[0], withPath)).toBe('src/mcp');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'mcp', path: 'src/mcp' }]),
      outDir: 'src/api',
    });
    const dirs = computeGeneratorOutputDirs(cfg, '/proj');
    expect(dirs).toContain(path.join('/proj', 'src/mcp'));
  });

  it('keeps the four options only this kind takes', () => {
    // Every one of these is a silent default if the schema drops it: `sdk` decides which package
    // the emitted server imports, and `stdio` decides whether a runnable entry point exists.
    const cfg = ConfigSchema.parse(
      base([
        {
          kind: 'mcp',
          sdk: 'v1',
          serverName: 'shop',
          serverVersion: '2.0.0',
          stdio: false,
          naming: { toolPrefix: 'db.' },
        },
      ])
    );
    const g = cfg.generators[0] as Record<string, unknown>;
    expect(g.sdk).toBe('v1');
    expect(g.serverName).toBe('shop');
    expect(g.serverVersion).toBe('2.0.0');
    expect(g.stdio).toBe(false);
    expect((g.naming as { toolPrefix?: string }).toolPrefix).toBe('db.');
  });

  it('refuses an sdk value that is neither generation', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'mcp', sdk: 'v3' }]))).toThrow();
  });

  it('refuses databaseInjection with a warning, because the handlers are stubs', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'mcp', databaseInjection: { enabled: true } }]))
    );
    expect(warnings.join('\n')).toMatch(/"mcp" generator sets databaseInjection/);
    expect(warnings.join('\n')).toMatch(/does not support/);
  });

  it('refuses includeRelations with a warning, because relation lookups are routes', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'mcp', includeRelations: true }]))
    );
    expect(warnings.join('\n')).toMatch(/"mcp" generator sets includeRelations/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('reads a validation block, unlike nestjs and graphql, so it does not warn on one', () => {
    // The constraint bounds this generator's tools advertise come from a sibling validation
    // generator's output, so `useShared` and `importPath` are read rather than reported.
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([
          { kind: 'zod', path: 'src/validators/zod' },
          { kind: 'mcp', validation: { useShared: true, importPath: 'src/validators/zod' } },
        ])
      )
    );
    expect(warnings.filter((w) => w.includes('"mcp"'))).toEqual([]);
  });

  it('does not warn on a plain mcp generator', () => {
    const { warnings } = resolveConfig(ConfigSchema.parse(base([{ kind: 'mcp' }])));
    expect(warnings).toEqual([]);
  });
});

describe('@drzl/cli config: the next generator', () => {
  const base = (generators: any[]) => ({ schema: 'src/db/schema.ts', generators });

  it('is a kind the schema accepts', () => {
    expect(() => ConfigSchema.parse(base([{ kind: 'next' }]))).not.toThrow();
  });

  it('writes to outDir by default and to path when given one', () => {
    const cfg = ConfigSchema.parse({ ...base([{ kind: 'next' }]), outDir: 'src/api' });
    expect(nextOutDir(cfg.generators[0], cfg)).toBe('src/api');
    const withPath = ConfigSchema.parse({
      ...base([{ kind: 'next', path: 'src/actions' }]),
      outDir: 'src/api',
    });
    expect(nextOutDir(withPath.generators[0], withPath)).toBe('src/actions');
  });

  it('is watched-around, so a rebuild does not retrigger itself', () => {
    const cfg = ConfigSchema.parse({
      ...base([{ kind: 'next', path: 'src/actions' }]),
      outDir: 'src/api',
    });
    expect(computeGeneratorOutputDirs(cfg, '/proj')).toContain(path.join('/proj', 'src/actions'));
  });

  it('reports a config with no validation generator to import from', () => {
    // This generator emits no schemas of its own, so a config naming it alone produces actions
    // that import from nothing. Said here rather than left to a failed import in the output.
    const { warnings } = resolveConfig(ConfigSchema.parse(base([{ kind: 'next' }])));
    expect(warnings.join('\n')).toMatch(/no "zod" generator for it to import from/);
  });

  it('says nothing once one is there', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'zod' }, { kind: 'next' }]))
    );
    expect(warnings.filter((w) => w.includes('"next"'))).toEqual([]);
  });

  it('says nothing when importPath points somewhere drzl does not generate', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'next', validation: { importPath: '@acme/schemas' } }])
      )
    );
    expect(warnings.filter((w) => w.includes('"next"'))).toEqual([]);
  });

  it('follows validation.library when deciding which sibling it needs', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'zod' }, { kind: 'next', validation: { library: 'valibot' } }])
      )
    );
    expect(warnings.join('\n')).toMatch(/no "valibot" generator/);
  });

  it('refuses includeRelations with a warning, because a relation lookup is a route', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(base([{ kind: 'zod' }, { kind: 'next', includeRelations: true }]))
    );
    expect(warnings.join('\n')).toMatch(/"next" generator sets includeRelations/);
    expect(warnings.join('\n')).toMatch(/does not read/);
  });

  it('refuses databaseInjection with a warning, because the handlers are stubs', () => {
    const { warnings } = resolveConfig(
      ConfigSchema.parse(
        base([{ kind: 'zod' }, { kind: 'next', databaseInjection: { enabled: true } }])
      )
    );
    expect(warnings.join('\n')).toMatch(/"next" generator sets databaseInjection/);
  });
});
