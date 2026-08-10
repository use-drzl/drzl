/**
 * The registry against the two things that have to agree with it.
 *
 * A generator used to be added in four places: the config enum, `generate`'s dispatch chain,
 * `watch`'s dispatch chain, and `computeGeneratorOutputDirs`. Forgetting one of the middle two is
 * invisible, because a kind with no branch is a kind that generates nothing and says nothing;
 * forgetting the last one is an infinite loop, because a watcher that does not ignore an output
 * directory regenerates from its own output forever.
 *
 * The two dispatch chains are one list now. These are the two edges that list still has, asserted
 * rather than reviewed.
 */
import { describe, expect, it } from 'vitest';
import {
  computeGeneratorOutputDirs,
  ConfigSchema,
  GENERATOR_KINDS,
  type DrzlConfig,
} from '../src/config.js';
import {
  GENERATORS,
  GENERATOR_BY_KIND,
  entryFor,
  resolveServicesDir,
} from '../src/generator-registry.js';

/** A config naming one generator of `kind`, defaulted exactly as a file on disk would be. */
function configFor(kind: string, path?: string): DrzlConfig {
  return ConfigSchema.parse({
    schema: './src/db/schema.ts',
    outDir: './api',
    generators: [{ kind, ...(path ? { path } : {}) }],
  }) as DrzlConfig;
}

describe('the registry and the config enum', () => {
  it('names exactly the kinds a config may name', () => {
    expect(GENERATORS.map((e) => e.kind).sort()).toEqual([...GENERATOR_KINDS].sort());
  });

  it('names each kind once', () => {
    expect(GENERATOR_BY_KIND.size).toBe(GENERATORS.length);
  });

  it('carries a scoped package name for every kind', () => {
    for (const entry of GENERATORS) {
      expect(entry.specifier, entry.kind).toMatch(/^@drzl\/generator-/);
    }
  });
});

describe('where the registry says each generator writes', () => {
  it('agrees with the directories the watcher ignores', () => {
    // The failure this prevents is not a wrong file, it is a watcher that never stops: a
    // directory missing from `computeGeneratorOutputDirs` raises a change event for every file
    // the generator just wrote, which triggers the rebuild that writes them again.
    for (const kind of GENERATOR_KINDS) {
      const cfg = configFor(kind);
      const ignored = computeGeneratorOutputDirs(cfg, '/tmp/project');
      const registry = entryFor(kind).outputDir(cfg.generators[0], cfg);
      expect(ignored, kind).toContain(`/tmp/project/${registry.replace(/^\.\//, '')}`);
    }
  });

  it('follows an explicit path for every kind that honours one', () => {
    for (const kind of GENERATOR_KINDS) {
      const cfg = configFor(kind, './somewhere/else');
      const registry = entryFor(kind).outputDir(cfg.generators[0], cfg);
      // oRPC is the one exception, and it is the generator's own long-standing arrangement
      // rather than an omission: it writes where the top-level `outDir` says and ignores `path`.
      expect(registry, kind).toBe(kind === 'orpc' ? './api' : './somewhere/else');
    }
  });
});

describe('where the services really are', () => {
  it('is the service generator path when the config names one', () => {
    const cfg = ConfigSchema.parse({
      schema: './s.ts',
      generators: [{ kind: 'trpc' }, { kind: 'service', path: './out/svc' }],
    }) as DrzlConfig;
    expect(resolveServicesDir(cfg)).toBe('./out/svc');
  });

  it('is the generator default when it does not, which is what a router template imports', () => {
    const cfg = configFor('trpc');
    expect(resolveServicesDir(cfg)).toBe('src/services');
  });
});
