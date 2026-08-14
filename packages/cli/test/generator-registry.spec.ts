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
import fs from 'node:fs';
import path from 'node:path';
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

describe('the registry against the manifest', () => {
  /**
   * The other half of the externalisation rule in `tsup.config.ts`.
   *
   * That file externalises whatever the manifest declares, so declared implies resolved from
   * `node_modules` rather than copied into `dist`. This is the converse, and it is the direction
   * a new generator breaks: an entry whose package no `dependencies` field names is a package
   * esbuild is entitled to bundle, and a bundled generator cannot be absent, so it can never
   * reach the install message and it travels with every copy of the CLI whether or not anybody
   * runs it. Eight of the fourteen were in exactly that state, for a publishing reason that
   * stopped applying, and nothing failed while they were.
   */
  const manifest = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  /**
   * The one exemption from both rules below, and a ledger entry rather than a permission.
   *
   * A package name that has never existed on npm cannot publish through trusted publishing, so a
   * release that introduces a generator *and* names it as a hard dependency ships a `@drzl/cli`
   * nobody can install: measured on 4.13.0, where `npm i @drzl/cli` returned a 404 for everyone
   * until the next release. An unresolvable *optional* dependency is skipped instead, which is
   * what makes the introducing release safe.
   *
   * Every name here has to leave, and leaving is one edit in two files: promote it in the manifest
   * and delete it here. `scripts/verify/stages/33-registry-deps.sh` is the half that reports when
   * that edit is due, because it can ask the registry and this cannot.
   */
  const AWAITING_FIRST_PUBLISH: string[] = [
    '@drzl/generator-forms',
    '@drzl/generator-openapi-fetch',
    '@drzl/generator-pothos',
  ];

  it('declares every generator package as a dependency', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    expect(
      GENERATORS.map((e) => e.specifier).filter(
        (s) => !declared.includes(s) && !AWAITING_FIRST_PUBLISH.includes(s)
      )
    ).toEqual([]);
  });

  it('leaves none of them optional, which an installer may skip without saying so', () => {
    // `npm install --omit=optional` resolves an optional dependency to nothing and exits 0, so a
    // kind declared there is a kind whose absence is decided by a flag rather than by a choice.
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    expect(
      GENERATORS.map((e) => e.specifier).filter(
        (s) => optional.includes(s) && !AWAITING_FIRST_PUBLISH.includes(s)
      )
    ).toEqual([]);
  });

  it('keeps the exemption honest in both directions', () => {
    // An entry that has been promoted but not deleted here would silently re-open the hole for
    // the next package, and one listed here that is not actually optional is not exempt from
    // anything. Both are the same edit going wrong halfway.
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const name of AWAITING_FIRST_PUBLISH) {
      expect(optional, `${name} is exempted but not optional`).toContain(name);
      expect(declared, `${name} is exempted and also a hard dependency`).not.toContain(name);
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
