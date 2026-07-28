import { describe, it, expect } from 'vitest';
import { loadConfig, defineConfig, ConfigSchema, resolveConfig } from '../src/config';
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
