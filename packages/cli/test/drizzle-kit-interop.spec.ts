/**
 * DRZL reading drizzle-kit's config, so a schema path written once in `drizzle.config.ts` does
 * not have to be written again in `drzl.config.ts` (item 59).
 *
 * Everything here is pinned to drizzle-kit's measured behavior on 0.31.10, read from its
 * published dist rather than from memory:
 *
 *   - `Config.schema` is `string | string[]`, entries may be glob patterns (`index.d.mts`).
 *   - The CLI's default config candidates are `drizzle.config.ts`, then `.js`, then `.json`,
 *     in that order (`drizzleConfigFromFile` in `bin.cjs`); `.mjs`/`.cjs` are not candidates,
 *     though an explicit `--config` path may be anything require() loads.
 *   - `prepareFilenames` expands each entry with glob.sync, expands a directory match one
 *     level (readdir, not recursive), and exits when nothing matched.
 *   - `defineConfig` is the identity function (`index.mjs`).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigSchema, computeWatchTargets } from '../src/config';
import {
  DRIZZLE_KIT_CONFIG_CANDIDATES,
  dialectMismatchWarning,
  expandSchemaPaths,
  findDrizzleKitConfig,
  mapDrizzleKitDialect,
  resolveSchemaSource,
  type ResolvedSchemaSource,
} from '../src/drizzle-kit';

const dirs: string[] = [];
async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-dk-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

const SCHEMA_TS = `import { pgTable, serial, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: serial('id').primaryKey(), email: text('email').notNull() });
`;

describe('config schema accepts the interop surface', () => {
  it('parses a config with drizzleKit and no schema', () => {
    const cfg = ConfigSchema.parse({ drizzleKit: true, generators: [{ kind: 'zod' }] });
    expect(cfg.schema).toBeUndefined();
    expect(cfg.drizzleKit).toBe(true);
  });

  it('parses a config with neither schema nor drizzleKit, deferring the error to resolution', () => {
    // The error a missing schema gets is "no schema and no drizzle.config", which can only be
    // said after looking for a drizzle.config; a parse-time "Required" cannot say it.
    expect(() => ConfigSchema.parse({ generators: [{ kind: 'zod' }] })).not.toThrow();
  });

  it('accepts a path for drizzleKit and refuses other types', () => {
    expect(
      ConfigSchema.parse({ drizzleKit: './kit.config.ts', generators: [{ kind: 'zod' }] })
        .drizzleKit
    ).toBe('./kit.config.ts');
    expect(() => ConfigSchema.parse({ drizzleKit: 5, generators: [{ kind: 'zod' }] })).toThrow();
  });
});

describe('findDrizzleKitConfig', () => {
  it('mirrors drizzle-kit: ts beats js beats json', async () => {
    const dir = await scratch({
      'drizzle.config.ts': 'export default {}',
      'drizzle.config.js': 'export default {}',
      'drizzle.config.json': '{}',
    });
    expect(findDrizzleKitConfig(dir)).toBe(path.join(dir, 'drizzle.config.ts'));
    await fs.rm(path.join(dir, 'drizzle.config.ts'));
    expect(findDrizzleKitConfig(dir)).toBe(path.join(dir, 'drizzle.config.js'));
    await fs.rm(path.join(dir, 'drizzle.config.js'));
    expect(findDrizzleKitConfig(dir)).toBe(path.join(dir, 'drizzle.config.json'));
  });

  it('does not treat .mjs as a candidate, because drizzle-kit itself does not', async () => {
    const dir = await scratch({ 'drizzle.config.mjs': 'export default {}' });
    expect(findDrizzleKitConfig(dir)).toBeNull();
    expect(DRIZZLE_KIT_CONFIG_CANDIDATES).toEqual([
      'drizzle.config.ts',
      'drizzle.config.js',
      'drizzle.config.json',
    ]);
  });
});

describe('expandSchemaPaths', () => {
  it('expands a glob to the matching files, sorted and absolute', async () => {
    const dir = await scratch({
      'src/db/b.ts': '',
      'src/db/a.ts': '',
      'src/db/readme.md': '',
    });
    const { files } = expandSchemaPaths('./src/db/*.ts', dir);
    expect(files).toEqual([path.join(dir, 'src/db/a.ts'), path.join(dir, 'src/db/b.ts')]);
  });

  it('supports arrays, globstar and braces, without duplicates', async () => {
    const dir = await scratch({
      'a/one.ts': '',
      'a/deep/two.ts': '',
      'b/three.js': '',
    });
    const { files } = expandSchemaPaths(['./a/**/*.ts', './b/*.{js,ts}', './a/one.ts'], dir);
    expect(files).toEqual([
      path.join(dir, 'a/deep/two.ts'),
      path.join(dir, 'a/one.ts'),
      path.join(dir, 'b/three.js'),
    ]);
  });

  it('expands a directory entry one level, the way drizzle-kit does', async () => {
    const dir = await scratch({
      'schema/users.ts': '',
      'schema/nested/deep.ts': '',
    });
    const { files } = expandSchemaPaths('./schema', dir);
    // prepareFilenames readdirs a directory without recursing; nested files need a glob.
    expect(files).toEqual([path.join(dir, 'schema/users.ts')]);
  });

  it('names watch directories that contain no glob magic', async () => {
    const dir = await scratch({ 'src/db/schema/users.ts': '', 'flat.ts': '' });
    const { watchDirs } = expandSchemaPaths(['./src/db/schema/*.ts', './flat.ts'], dir);
    expect(watchDirs).toContain(path.join(dir, 'src/db/schema'));
    expect(watchDirs).toContain(dir);
    for (const d of watchDirs) {
      expect(path.isAbsolute(d), d).toBe(true);
      expect(d).not.toMatch(/[*?{}[\]]/);
    }
  });
});

describe('dialect mapping and the mismatch warning', () => {
  it('maps every dialect drizzle-kit 0.31 can declare', () => {
    expect(mapDrizzleKitDialect('postgresql')).toBe('postgres');
    expect(mapDrizzleKitDialect('mysql')).toBe('mysql');
    expect(mapDrizzleKitDialect('sqlite')).toBe('sqlite');
    expect(mapDrizzleKitDialect('turso')).toBe('sqlite');
    expect(mapDrizzleKitDialect('singlestore')).toBe('singlestore');
    expect(mapDrizzleKitDialect('gel')).toBe('gel');
    expect(mapDrizzleKitDialect('no-such-dialect')).toBeNull();
  });

  it('warns when the declared dialect contradicts the analyzed one', () => {
    const w = dialectMismatchWarning({
      configPath: '/p/drizzle.config.ts',
      declared: 'mysql',
      analyzed: 'postgres',
    });
    expect(w).toBe(
      'drzl: /p/drizzle.config.ts declares dialect "mysql", but the schema analyzed as ' +
        '"postgres". DRZL follows the schema; if the schema files are the right ones, the ' +
        'dialect in that config is stale.'
    );
  });

  it('stays quiet when they agree, including through the turso alias', () => {
    expect(
      dialectMismatchWarning({ configPath: 'x', declared: 'turso', analyzed: 'sqlite' })
    ).toBeNull();
    expect(
      dialectMismatchWarning({ configPath: 'x', declared: 'postgresql', analyzed: 'postgres' })
    ).toBeNull();
  });

  it('stays quiet when either side is unknown', () => {
    expect(
      dialectMismatchWarning({ configPath: 'x', declared: 'mysql', analyzed: 'unknown' })
    ).toBeNull();
    expect(
      dialectMismatchWarning({ configPath: 'x', declared: 'weird', analyzed: 'postgres' })
    ).toBeNull();
  });
});

describe('resolveSchemaSource precedence', () => {
  it('an explicit drzl schema wins outright, with no drizzle-kit involvement', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/other.ts' }`,
      'src/schema.ts': SCHEMA_TS,
    });
    const src = await resolveSchemaSource({ schema: 'src/schema.ts' }, dir);
    expect(src.source).toBe('drzl');
    expect(src.schema).toBe('src/schema.ts');
    expect(src.drizzleKitConfigPath).toBeUndefined();
    expect(src.warnings).toEqual([]);
    expect(src.watchDirs).toEqual([path.join(dir, 'src')]);
  });

  it('warns when both schema and drizzleKit are set, since only schema is read', async () => {
    const dir = await scratch({ 'src/schema.ts': SCHEMA_TS });
    const src = await resolveSchemaSource({ schema: 'src/schema.ts', drizzleKit: true }, dir);
    expect(src.source).toBe('drzl');
    expect(src.warnings.join('\n')).toContain('both "schema" and "drizzleKit"');
  });

  it('drizzleKit: true reads the drizzle-kit config and expands its schema', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/db/*.ts' }`,
      'src/db/users.ts': SCHEMA_TS,
      'src/db/posts.ts': SCHEMA_TS.replace(/users/g, 'posts'),
    });
    const src = await resolveSchemaSource({ drizzleKit: true }, dir);
    expect(src.source).toBe('drizzle-kit');
    expect(src.schema).toEqual([
      path.join(dir, 'src/db/posts.ts'),
      path.join(dir, 'src/db/users.ts'),
    ]);
    expect(src.drizzleKitConfigPath).toBe(path.join(dir, 'drizzle.config.ts'));
    expect(src.drizzleKitDialect).toBe('postgresql');
  });

  it('falls back to drizzle.config automatically when schema is simply omitted', async () => {
    // Deliberate: until this feature, `schema` was required, so no pre-existing config can
    // reach this branch; it exists only for configs written with the interop in mind. The
    // resolution is announced by the caller (the CLI prints the file it read), never silent.
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/db/users.ts' }`,
      'src/db/users.ts': SCHEMA_TS,
    });
    const src = await resolveSchemaSource({}, dir);
    expect(src.source).toBe('drizzle-kit');
    expect(src.schema).toEqual([path.join(dir, 'src/db/users.ts')]);
  });

  it('drizzleKit: false disables the fallback even when a drizzle.config exists', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/db/users.ts' }`,
      'src/db/users.ts': SCHEMA_TS,
    });
    await expect(resolveSchemaSource({ drizzleKit: false }, dir)).rejects.toThrow(
      /"drizzleKit" is false/
    );
  });

  it('accepts an explicit path to the drizzle-kit config, wherever it is', async () => {
    const dir = await scratch({
      'conf/kit.config.mjs': `export default { dialect: 'sqlite', schema: './src/db/users.ts' }`,
      'src/db/users.ts': SCHEMA_TS,
    });
    const src = await resolveSchemaSource({ drizzleKit: './conf/kit.config.mjs' }, dir);
    expect(src.source).toBe('drizzle-kit');
    expect(src.schema).toEqual([path.join(dir, 'src/db/users.ts')]);
    expect(src.drizzleKitConfigPath).toBe(path.join(dir, 'conf/kit.config.mjs'));
  });

  it('reads a .json drizzle-kit config', async () => {
    const dir = await scratch({
      'drizzle.config.json': JSON.stringify({ dialect: 'postgresql', schema: './src/db/users.ts' }),
      'src/db/users.ts': SCHEMA_TS,
    });
    const src = await resolveSchemaSource({ drizzleKit: true }, dir);
    expect(src.schema).toEqual([path.join(dir, 'src/db/users.ts')]);
  });

  it('reads a config written with defineConfig, which drizzle-kit defines as identity', async () => {
    const dir = await scratch({
      // Measured: drizzle-kit's index.mjs is `function defineConfig(config) { return config; }`.
      'drizzle.config.ts': `const defineConfig = <T,>(c: T): T => c;
export default defineConfig({ dialect: 'postgresql', schema: ['./src/db/users.ts'] });`,
      'src/db/users.ts': SCHEMA_TS,
    });
    const src = await resolveSchemaSource({ drizzleKit: true }, dir);
    expect(src.schema).toEqual([path.join(dir, 'src/db/users.ts')]);
  });

  it('errors naming both files when neither yields a schema', async () => {
    const dir = await scratch({ 'src/db/users.ts': SCHEMA_TS });
    await expect(resolveSchemaSource({}, dir)).rejects.toThrow(/no "schema".*drizzle\.config\.ts/s);
  });

  it('errors when drizzleKit is true but no config file exists', async () => {
    const dir = await scratch({});
    await expect(resolveSchemaSource({ drizzleKit: true }, dir)).rejects.toThrow(
      /drizzleKit.*drizzle\.config\.ts/s
    );
  });

  it('errors when the explicit drizzleKit path does not exist', async () => {
    const dir = await scratch({});
    await expect(resolveSchemaSource({ drizzleKit: './nope/kit.ts' }, dir)).rejects.toThrow(
      /nope[/\\]kit\.ts/
    );
  });

  it('errors when the drizzle-kit config has no schema entry', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql' }`,
    });
    await expect(resolveSchemaSource({ drizzleKit: true }, dir)).rejects.toThrow(/no "schema"/);
  });

  it('errors when the schema entry is neither string nor string array', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: 42 }`,
    });
    await expect(resolveSchemaSource({ drizzleKit: true }, dir)).rejects.toThrow(
      /string or an array of strings/
    );
  });

  it('errors when the patterns match nothing, naming them', async () => {
    const dir = await scratch({
      'drizzle.config.ts': `export default { dialect: 'postgresql', schema: './src/db/*.ts' }`,
    });
    await expect(resolveSchemaSource({ drizzleKit: true }, dir)).rejects.toThrow(
      /matched no schema files.*src\/db\/\*\.ts/s
    );
  });
});

describe('watch targets with a drizzle-kit source', () => {
  const cwd = path.resolve('/project');
  const cfg = (over: Record<string, unknown> = {}) =>
    ({
      outDir: 'src/api',
      generators: [{ kind: 'zod', path: 'src/validators/zod' }],
      analyzer: {},
      ...over,
    }) as never;
  const source: ResolvedSchemaSource = {
    source: 'drizzle-kit',
    schema: ['/project/src/db/schema/users.ts'],
    watchDirs: ['/project/src/db/schema'],
    drizzleKitConfigPath: '/project/drizzle.config.ts',
    warnings: [],
  };

  it('watches the resolved schema directories and the drizzle-kit config file', () => {
    const targets = computeWatchTargets(cfg(), cwd, source);
    expect(targets).toContain(path.resolve('/project/src/db/schema'));
    expect(targets).toContain(path.resolve('/project/drizzle.config.ts'));
  });

  it('still watches every drzl config filename, and emits no globs', () => {
    const targets = computeWatchTargets(cfg(), cwd, source);
    for (const name of ['drzl.config.ts', 'drzl.config.js', 'drzl.config.mjs', 'drzl.config.cjs']) {
      expect(targets).toContain(path.resolve(cwd, name));
    }
    for (const t of targets) {
      expect(t, `glob in watch target: ${t}`).not.toMatch(/[*?{}[\]]/);
      expect(path.isAbsolute(t), t).toBe(true);
    }
  });

  it('tolerates a config with no schema when no source is passed', () => {
    // The startup path resolves the source before computing targets, but an old caller
    // passing only the config must not crash on schema being undefined now.
    expect(() => computeWatchTargets(cfg(), cwd)).not.toThrow();
  });
});
