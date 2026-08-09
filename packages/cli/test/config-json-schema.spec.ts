/**
 * The JSON Schema shipped for `drzl.config.json`.
 *
 * `drzl.config.json` has always been a supported config form (`loadConfig`'s candidate list), and
 * a JSON file gets none of the completion a `.ts` config gets from `defineConfig`. The schema is
 * how an editor learns the shape.
 *
 * A generated schema is only worth shipping if its verdicts match the CLI's, so the divergences
 * are asserted here rather than assumed:
 *
 *  - `z.toJSONSchema` defaults to `io: 'output'`, which marks every key carrying a `.default()`
 *    as `required`. That schema rejects almost every real config, including all 32 in the docs.
 *    The builder passes `io: 'input'`; `rejects nothing the CLI accepts` below is the guard.
 *  - `z.toJSONSchema` silently drops refinements. `ConfigSchema`'s one `.superRefine` carries the
 *    affix rules, so the character half is re-encoded as a `pattern` and proven equivalent to
 *    `validateAffix` by differential fuzz; the collision half cannot be expressed in JSON Schema
 *    and is asserted here as a known, documented gap rather than left to be discovered.
 */
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { validateAffix, AFFIX_PREFIX_PATTERN, AFFIX_SUFFIX_PATTERN } from '@drzl/validation-core';
import { buildConfigJsonSchema, ConfigSchema, CONFIG_FILE_NAMES } from '../src/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const docsDir = path.join(repoRoot, 'docs');
const publishedCopy = path.join(docsDir, 'public', 'drzl.config.schema.json');

const schema = buildConfigJsonSchema();
const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

/** Every config the docs tell a reader to copy, as a plain object. */
async function docCorpus(): Promise<{ where: string; config: Record<string, unknown> }[]> {
  const extract = path.join(repoRoot, 'scripts', 'extract-doc-configs.mjs');
  // The same extractor the packed gate uses, so the corpus cannot drift from the one CI runs.
  const raw = execFileSync(process.execPath, [extract, docsDir], { encoding: 'utf8' });
  const blocks: { file: string; line: number; config: string }[] = JSON.parse(raw);

  // The OS temp dir, not a directory inside the package. These blocks have their imports stripped
  // so they resolve nothing and do not need to sit beside node_modules, and a tree of generated
  // `.ts` files left inside the package is picked up by eslint and by anything else that walks it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drzl-doc-configs-'));
  const jiti = createJiti(path.join(tmp, 'x.ts'), { interopDefault: true, tryNative: false });

  const out: { where: string; config: Record<string, unknown> }[] = [];
  for (const [i, b] of blocks.entries()) {
    // `defineConfig` is the identity function this package exports; declaring it locally keeps
    // the block otherwise byte-identical to what a reader copies out of the docs.
    const body = b.config
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('import '))
      .join('\n');
    const file = path.join(tmp, `block-${i}.ts`);
    fs.writeFileSync(file, `const defineConfig = (c: any) => c;\n${body}`);
    const mod = (await jiti.import(file)) as { default?: unknown };
    out.push({
      where: `${b.file}:${b.line}`,
      config: (mod.default ?? mod) as Record<string, unknown>,
    });
  }
  return out;
}

describe('drzl.config.schema.json', () => {
  it('is a draft-07 schema with a stable $id and a documented $schema key', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.$id).toBe('https://use-drzl.github.io/drzl/drzl.config.schema.json');
    // Without this a reader who adds the `$schema` key the docs tell them to add sees their own
    // pointer flagged as an unknown property by editors that report them.
    expect((schema.properties as Record<string, unknown>).$schema).toBeDefined();
  });

  it('accepts a $schema key, exactly as the CLI does', () => {
    const cfg = {
      $schema: './node_modules/@drzl/cli/dist/drzl.config.schema.json',
      schema: 'src/db/schema.ts',
      generators: [{ kind: 'orpc' }],
    };
    expect(validate(cfg), JSON.stringify(validate.errors)).toBe(true);
    expect(() => ConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects nothing the CLI accepts: every config in the docs validates', async () => {
    const corpus = await docCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(30);
    const failures: string[] = [];
    for (const { where, config } of corpus) {
      // The CLI's own verdict first, so a docs config that is simply wrong is not blamed on the
      // schema.
      ConfigSchema.parse(config);
      if (!validate(config)) {
        failures.push(`${where}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('rejects a config the CLI rejects', () => {
    const broken = {
      schema: 'src/db/schema.ts',
      outDir: 42, // outDir is a string
      generators: [{ kind: 'not-a-real-generator' }],
    };
    expect(validate(broken)).toBe(false);
    expect(() => ConfigSchema.parse(broken)).toThrow();
  });

  it('requires none of the keys that carry a default, which io:output would have', () => {
    // The whole failure mode of a generated schema: `outDir`, `importExtension`, `analyzer` and
    // `generators` all have `.default()`, so `io: 'output'` marks them required and every config
    // omitting them lights up red in the editor while working perfectly.
    expect(schema.required ?? []).toEqual([]);
    const minimal = { schema: 'src/db/schema.ts' };
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
    expect(() => ConfigSchema.parse(minimal)).not.toThrow();
  });

  it('mirrors the CLI on unknown keys: strict objects reject, the rest ignore', () => {
    // `ConfigSchema` is not strict, so the CLI strips an unknown top-level key silently. The
    // schema says the same thing rather than flagging a config that works.
    const unknownTop = { schema: 's.ts', notAnOption: true, generators: [{ kind: 'orpc' }] };
    expect(validate(unknownTop)).toBe(true);
    expect(() => ConfigSchema.parse(unknownTop)).not.toThrow();

    // `ColumnRulesSchema` is `.strict()`, so both reject.
    const unknownNested = { schema: 's.ts', columns: { users: { omitt: ['x'] } } };
    expect(validate(unknownNested)).toBe(false);
    expect(() => ConfigSchema.parse(unknownNested)).toThrow();
  });

  it('carries the affix character rule that the dropped superRefine would have enforced', () => {
    const bad = {
      schema: 's.ts',
      generators: [{ kind: 'zod', affix: { schema: { suffix: 'my-schema' } } }],
    };
    // A hyphen cannot appear in a TypeScript identifier. Before the pattern was re-encoded the
    // JSON Schema said this was fine and the CLI then refused to generate.
    expect(validate(bad)).toBe(false);
    expect(() => ConfigSchema.parse(bad)).toThrow();
  });

  it('encodes a pattern equivalent to validateAffix, over every printable ASCII position', () => {
    const CHAR_RULE = 'cannot appear in a TypeScript identifier';
    const pre = new RegExp(AFFIX_PREFIX_PATTERN);
    const suf = new RegExp(AFFIX_SUFFIX_PATTERN);

    const corpus: string[] = ['', 'Insert', '_x', '$x', '9X', 'a-b', 'a b', 'a.b', 'é', '你好', '😀'];
    for (let c = 32; c < 127; c++) {
      const ch = String.fromCharCode(c);
      corpus.push(ch, `a${ch}`, `${ch}a`);
    }

    const mismatches: string[] = [];
    for (const v of corpus) {
      // One mode only, so the collision rule cannot fire on a character-legal value and be
      // mistaken for a character verdict.
      const charOnly = (issues: { message: string }[]) =>
        issues.filter((i) => i.message.includes(CHAR_RULE)).length === 0;
      const zodPrefix = charOnly(validateAffix({ schema: { prefix: { insert: v } } }));
      if (zodPrefix !== pre.test(v)) mismatches.push(`prefix ${JSON.stringify(v)}`);
      const zodSuffix = charOnly(validateAffix({ schema: { suffix: { insert: v } } }));
      if (zodSuffix !== suf.test(v)) mismatches.push(`suffix ${JSON.stringify(v)}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('cannot express the affix collision rule, which stays a CLI-only error', () => {
    // Documented gap. Two modes resolving to the same identifier is a comparison between sibling
    // values, which JSON Schema has no way to state. The CLI still catches it; the editor does
    // not, and docs/guide/configuration.md says so.
    const colliding = {
      schema: 's.ts',
      generators: [
        { kind: 'zod', affix: { schema: { prefix: { insert: 'A', update: 'A', select: 'B' } } } },
      ],
    };
    expect(validate(colliding)).toBe(true);
    expect(() => ConfigSchema.parse(colliding)).toThrow(/collide/);
  });

  it('ships at the path the docs tell people to point $schema at', () => {
    // Deliberately not an `exports` entry: `$schema` and VS Code's `json.schemas` take a
    // filesystem path, which does not consult `exports`, and a JSON file in that map breaks
    // every-entry-loads.spec.ts, whose premise is that every entry is a loadable module. So the
    // contract between the docs and the build is asserted here instead of by the manifest.
    const docPath = './node_modules/@drzl/cli/dist/drzl.config.schema.json';
    const built = path.join(here, '..', 'dist', 'drzl.config.schema.json');
    expect(docPath.endsWith(`/@drzl/cli/${path.relative(path.join(here, '..'), built)}`)).toBe(true);
    expect(fs.existsSync(built), `${built} is missing; run pnpm --filter @drzl/cli build`).toBe(
      true
    );
    expect(JSON.parse(fs.readFileSync(built, 'utf8'))).toEqual(schema);

    // `files` has to carry it, or none of the above reaches a consumer.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')
    ) as { files: string[] };
    expect(manifest.files).toContain('dist');

    const guide = fs.readFileSync(path.join(docsDir, 'guide', 'configuration.md'), 'utf8');
    expect(guide).toContain(docPath);
  });

  it('matches the copy published on the docs site', () => {
    // The docs copy is what `$schema` points at over the network and what a SchemaStore entry
    // would fetch. Regenerate with `pnpm --filter @drzl/cli build`.
    expect(fs.existsSync(publishedCopy), `${publishedCopy} is missing`).toBe(true);
    const onDisk = fs.readFileSync(publishedCopy, 'utf8');
    expect(onDisk).toBe(`${JSON.stringify(schema, null, 2)}\n`);
  });
});

describe('config file names', () => {
  it('are one list, so the loader and the watcher cannot disagree', () => {
    expect([...CONFIG_FILE_NAMES]).toEqual([
      'drzl.config.ts',
      'drzl.config.mjs',
      'drzl.config.js',
      'drzl.config.cjs',
      'drzl.config.json',
    ]);
  });
});
