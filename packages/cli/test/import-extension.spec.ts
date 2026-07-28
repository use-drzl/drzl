import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, loadConfig, resolveConfig } from '../src/config';

const base = (extra: Record<string, unknown> = {}, generators: any[] = [{ kind: 'zod' }]) => ({
  schema: 'src/db/schema.ts',
  generators,
  ...extra,
});

const resolved = (raw: unknown) => resolveConfig(ConfigSchema.parse(raw)).config;

describe('@drzl/cli importExtension', () => {
  it('defaults to js', () => {
    const cfg = ConfigSchema.parse(base());
    expect(cfg.importExtension).toBe('js');
  });

  // A consumer compiles the whole generated tree with one tsconfig, so a setting that only
  // reached the generator it was written on would leave half the tree unresolvable.
  it('reaches every generator from the top level', () => {
    const cfg = resolved(
      base({ importExtension: 'none' }, [
        { kind: 'zod' },
        { kind: 'valibot' },
        { kind: 'arktype' },
        { kind: 'service' },
        { kind: 'orpc' },
      ])
    );
    expect(cfg.generators.map((g) => g.importExtension)).toEqual([
      'none',
      'none',
      'none',
      'none',
      'none',
    ]);
  });

  it('reaches every generator when left on the default', () => {
    const cfg = resolved(base({}, [{ kind: 'zod' }, { kind: 'orpc' }]));
    expect(cfg.generators.map((g) => g.importExtension)).toEqual(['js', 'js']);
  });

  it('lets one generator override the top level', () => {
    const cfg = resolved(
      base({ importExtension: 'js' }, [{ kind: 'zod' }, { kind: 'service', importExtension: 'ts' }])
    );
    expect(cfg.generators.map((g) => g.importExtension)).toEqual(['js', 'ts']);
  });

  it('rejects a value that is not one of the three', () => {
    expect(() => ConfigSchema.parse(base({ importExtension: 'mjs' }))).toThrow();
    expect(() => ConfigSchema.parse(base({}, [{ kind: 'zod', importExtension: 'cjs' }]))).toThrow();
  });

  it('survives a round trip through loadConfig', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-cli-ext-'));
    const file = path.join(dir, 'drzl.config.json');
    try {
      await fs.writeFile(
        file,
        JSON.stringify({
          schema: 'src/db/schema.ts',
          importExtension: 'none',
          generators: [{ kind: 'zod' }, { kind: 'orpc' }],
        }),
        'utf8'
      );
      const cfg = await loadConfig(file);
      expect(cfg?.importExtension).toBe('none');
      expect(cfg?.generators.map((g) => g.importExtension)).toEqual(['none', 'none']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
