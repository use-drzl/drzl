/**
 * The metadata every package publishes has to describe that package.
 *
 * `@drzl/generator-typebox` shipped `"repository": { "directory": "packages/generator-valibot" }`
 * for its whole life, so its npm page's "source" link sent every reader to a sibling package. It
 * was found by hand, months in, and nothing about the package was otherwise wrong: it built,
 * published and worked. A copy-pasted manifest is the normal way a package is created here, so
 * the field that has to be edited afterwards is the field that gets missed.
 *
 * These are cheap and they are checked from the workspace rather than from a tarball because
 * `pnpm pack` copies the manifest through unchanged apart from resolving `workspace:` ranges. The
 * tarball's own contents, and whether the files these fields point at actually ship, are asserted
 * in scripts/verify-packed.sh, which is the stage that has a tarball to look inside.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const packagesDir = path.join(repoRoot, 'packages');

interface Manifest {
  name: string;
  private?: boolean;
  description?: string;
  keywords?: string[];
  files?: string[];
  repository?: { type?: string; url?: string; directory?: string };
  funding?: { type?: string; url?: string };
  publishConfig?: { access?: string; registry?: string; provenance?: boolean };
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const publishable: { dir: string; manifest: Manifest }[] = fs
  .readdirSync(packagesDir)
  .filter((dir) => fs.existsSync(path.join(packagesDir, dir, 'package.json')))
  .map((dir) => ({ dir, manifest: read(path.join(packagesDir, dir, 'package.json')) as Manifest }))
  .filter((p) => !p.manifest.private);

const root = read(path.join(repoRoot, 'package.json'));

/**
 * The word that tells one package from another, which is the directory name with the family
 * prefix removed: `generator-valibot` is distinguished by `valibot`, not by `generator`.
 *
 * This is the form a copy-paste survivor takes. A description lifted from the valibot package
 * says "valibot", never "generator-valibot", so matching on the full directory name would miss
 * exactly the case this exists for.
 */
const term = (dir: string) => dir.replace(/^(generator|template)-/, '');

/** Lowercased, with every run of non-alphanumerics collapsed to one hyphen, so "JSON Schema"
 *  and "json-schema" are the same string and a term cannot hide behind punctuation. */
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Whether a term appears in some text as whole words rather than as a substring.
 *
 * Both sides are already hyphen-joined by `normalise`, so wrapping each in hyphens turns "does
 * this text contain these words in this order" into one `includes`. Without the wrapping, "cli"
 * matches "client" and every description of the oRPC generator that mentions a typed client
 * would read as a copy-paste from the CLI package.
 */
const mentions = (text: string, t: string) => `-${text}-`.includes(`-${t}-`);

/**
 * Terms that are ordinary words in this domain, and so cannot be evidence of anything.
 *
 * Whole-word matching is not enough on its own here, because some of these directory names are
 * also words a correct description needs. "Standard Schema" is the name of the specification the
 * generators target and is already used in packages/generator-orpc/src/index.ts and its README,
 * so it would convict @drzl/generator-zod of copying @drzl/template-standard. "Service" is what
 * the service generator emits and what an oRPC router calls. "CLI" and "analyzer" are ordinary
 * nouns any of these packages may need.
 *
 * Everything left is a proper noun that belongs to exactly one package: arktype, json-schema,
 * orpc, typebox, valibot, zod, orpc-service, validation-core. Those are the ones a copied
 * description carries over, which is the case this check exists for.
 */
const TOO_GENERIC_TO_CONVICT = new Set(['analyzer', 'cli', 'service', 'standard']);

const terms = publishable.map((p) => term(p.dir)).filter((t) => !TOO_GENERIC_TO_CONVICT.has(t));

it('found every publishable package', () => {
  // Without this the table below could quietly go empty and every assertion would pass on
  // nothing at all.
  expect(publishable.map((p) => p.dir).sort()).toEqual([
    'analyzer',
    'cli',
    'generator-ai',
    'generator-arktype',
    'generator-effect',
    'generator-effect-http',
    'generator-elysia',
    'generator-express',
    'generator-fast-check',
    'generator-fastify',
    'generator-graphql',
    'generator-h3',
    'generator-hono',
    'generator-json-schema',
    'generator-mcp',
    'generator-nestjs',
    'generator-next',
    'generator-orpc',
    'generator-seed',
    'generator-service',
    'generator-tanstack-start',
    'generator-trpc',
    'generator-ts-rest',
    'generator-typebox',
    'generator-valibot',
    'generator-zod',
    'template-orpc-service',
    'template-standard',
    'validation-core',
  ]);
});

describe.each(publishable)('$manifest.name', ({ dir, manifest }) => {
  it('is named after the directory it lives in', () => {
    expect(manifest.name).toBe(`@drzl/${dir}`);
  });

  it('points repository.directory at its own source', () => {
    // The typebox/valibot mix-up, and the only assertion in this file that has already caught a
    // real one.
    expect(manifest.repository?.directory).toBe(`packages/${dir}`);
  });

  it('points at this repository', () => {
    expect(manifest.repository?.url).toBe('https://github.com/use-drzl/drzl');
  });

  it('carries the same funding link as the workspace', () => {
    // Copied from the root manifest rather than written out here, so the two cannot drift apart
    // without this failing.
    expect(manifest.funding).toEqual(root.funding);
  });

  it('publishes publicly, to npm, with provenance', () => {
    // The release workflow also sets NPM_CONFIG_PROVENANCE, so this is the second of two
    // switches. Whether the published artefact actually carries an attestation is a question
    // about the registry, and is asserted in scripts/verify-packed.sh.
    expect(manifest.publishConfig).toEqual({
      access: 'public',
      registry: 'https://registry.npmjs.org/',
      provenance: true,
    });
  });

  it('ships dist and nothing from the working tree', () => {
    // `pnpm pack` adds package.json, README and LICENSE on its own whatever `files` says, so an
    // entry naming any of those is redundant rather than wrong. Anything else listed here is
    // source, configuration or test material that a consumer has no use for.
    expect(manifest.files).toContain('dist');
    const shippable = /^(dist|README\.md|LICENSE|CHANGELOG\.md)$/;
    expect(manifest.files?.filter((f) => !shippable.test(f))).toEqual([]);
  });

  it('does not describe itself with another package name', () => {
    const own = term(dir);
    // A term that is part of this package's own term cannot be evidence of a copy-paste:
    // `orpc` is inside `orpc-service`, and the template is entitled to say the word.
    const foreign = terms.filter((t) => t !== own && !own.includes(t));
    const text = normalise([manifest.description ?? '', ...(manifest.keywords ?? [])].join(' '));
    expect(foreign.filter((t) => mentions(text, t))).toEqual([]);
  });
});

it('gives no two packages the same description', () => {
  // The other half of a copy-paste: the wrong name is caught above, an identical description that
  // names nothing is caught here.
  const described = publishable.filter((p) => p.manifest.description);
  const seen = new Map<string, string>();
  const clashes: string[] = [];
  for (const p of described) {
    const key = normalise(p.manifest.description!);
    const first = seen.get(key);
    if (first) clashes.push(`${first} and ${p.manifest.name} share a description`);
    else seen.set(key, p.manifest.name);
  }
  expect(clashes).toEqual([]);
});
