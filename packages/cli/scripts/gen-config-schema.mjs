/**
 * Write `drzl.config.schema.json` from the zod schema that actually validates the config.
 *
 * Runs as the tail of this package's build, from `dist/config.js` rather than from `src`, so the
 * schema describes the same code the tarball ships. Two copies, written by one run so they cannot
 * disagree:
 *
 *   - `dist/`, which `files: ["dist"]` publishes. A consumer points `$schema` at
 *     `./node_modules/@drzl/cli/dist/drzl.config.schema.json` and gets the schema for the version
 *     they installed, offline.
 *   - `docs/public/`, which VitePress serves at the `$id` URL. That copy is committed, and
 *     packages/cli/test/config-json-schema.spec.ts fails if it drifts from this generator.
 *
 * Writing into docs/ from a package build is deliberate: the alternative was a second entry point
 * and a second invocation that could be forgotten independently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const { buildConfigJsonSchema } = await import(
  path.join(pkgRoot, 'dist', 'config.js')
);

const json = `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;

const targets = [
  path.join(pkgRoot, 'dist', 'drzl.config.schema.json'),
  path.join(repoRoot, 'docs', 'public', 'drzl.config.schema.json'),
];

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json);
  console.log(`  config schema -> ${path.relative(repoRoot, target)}`);
}
