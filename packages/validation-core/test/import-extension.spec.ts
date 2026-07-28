import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPORT_EXTENSION,
  IMPORT_EXTENSIONS,
  importSpecifier,
  moduleFileName,
  moduleSpecifier,
  type ImportExtension,
} from '../src';

/**
 * Whether a specifier the barrel emits actually reaches the file the generator wrote, asked
 * of TypeScript's own resolver rather than of a rule written down from memory.
 *
 * Generated files land in the consumer's source tree, so it is the consumer's tsconfig that
 * decides. The grid below is every combination a consumer can be in: the four
 * `moduleResolution` settings TypeScript has shipped, times the two module systems a `.ts`
 * file can be in, which is what `"type": "module"` in the nearest package.json picks.
 */
const RESOLUTIONS = {
  bundler: {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
  node10: {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  },
  node16: {
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
  },
  nodenext: {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  },
} satisfies Record<string, ts.CompilerOptions>;

type ResolutionName = keyof typeof RESOLUTIONS;
const RESOLUTION_NAMES = Object.keys(RESOLUTIONS) as ResolutionName[];

/** ESM vs CJS for the importing file, which is what `"type": "module"` decides. */
const MODULE_SYSTEMS = { esm: ts.ModuleKind.ESNext, cjs: ts.ModuleKind.CommonJS } as const;
type ModuleSystem = keyof typeof MODULE_SYSTEMS;
const MODULE_SYSTEM_NAMES = Object.keys(MODULE_SYSTEMS) as ModuleSystem[];

/** Every cell of the grid, as `bundler/esm`, `node16/cjs` and so on. */
const CELLS = RESOLUTION_NAMES.flatMap((r) => MODULE_SYSTEM_NAMES.map((m) => `${r}/${m}` as const));

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drzl-import-extension-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let caseCount = 0;

/**
 * Write a file the way a generator would, then report which cells of the grid the given
 * specifier resolves back to it in.
 *
 * Each call gets its own directory: leaving a `users.zod.ts` from an earlier case next to a
 * `users.zod.tsx` would let a specifier resolve to the wrong neighbour and quietly pass.
 */
async function reachedIn(fileName: string, specifier: string, allowTsExtensions: boolean) {
  const caseDir = join(dir, `case-${caseCount++}`);
  await mkdir(caseDir, { recursive: true });
  const target = join(caseDir, fileName);
  await writeFile(target, 'export const marker = 1;\n', 'utf8');
  const barrel = join(caseDir, 'index.ts');
  await writeFile(barrel, `export * from '${specifier}';\n`, 'utf8');

  return CELLS.filter((cell) => {
    const [resolution, moduleSystem] = cell.split('/') as [ResolutionName, ModuleSystem];
    const resolved = ts.resolveModuleName(
      specifier,
      barrel,
      { ...RESOLUTIONS[resolution], allowImportingTsExtensions: allowTsExtensions },
      ts.sys,
      undefined,
      undefined,
      MODULE_SYSTEMS[moduleSystem]
    ).resolvedModule?.resolvedFileName;
    return resolved === target.replace(/\\/g, '/');
  });
}

/** Suffixes worth checking: the three defaults plus every shape the helpers special-case. */
const SUFFIXES = ['.zod.ts', '.valibot.ts', '.arktype.ts', '.schema.ts', 'Schema.ts', '.ts'];

describe('importExtension resolves where it claims to', () => {
  it('defaults to js', () => {
    expect(DEFAULT_IMPORT_EXTENSION).toBe('js');
    expect(moduleSpecifier('users', '.zod.ts')).toBe('./users.zod.js');
  });

  // The whole point of the default: a consumer on any tsconfig can compile the barrel.
  for (const suffix of SUFFIXES) {
    it(`reaches the emitted file in every cell with the default and fileSuffix ${suffix}`, async () => {
      const file = moduleFileName('users', suffix);
      const specifier = moduleSpecifier('users', suffix);
      expect(await reachedIn(file, specifier, false)).toEqual(CELLS);
    });
  }

  it('reaches the emitted file in every cell for .mts and .cts', async () => {
    for (const suffix of ['.zod.mts', '.zod.cts', '.mts', '.cts']) {
      const file = moduleFileName('users', suffix);
      expect(await reachedIn(file, moduleSpecifier('users', suffix), false)).toEqual(CELLS);
    }
  });

  it('reaches the emitted file in every cell for .tsx', async () => {
    const file = moduleFileName('users', '.zod.tsx');
    expect(await reachedIn(file, moduleSpecifier('users', '.zod.tsx'), false)).toEqual(CELLS);
  });

  // 'none' is what drzl emitted before 2.0. It is kept because a pipeline that cannot map
  // '.js' back to '.ts' needs it, but it is not a default anyone can rely on: these are the
  // two cells that made this a breaking change rather than a bug fix.
  it('misses node16 and nodenext ES modules with none, which is why it is no longer the default', async () => {
    const file = moduleFileName('users', '.zod.ts');
    const specifier = moduleSpecifier('users', '.zod.ts', 'none');
    expect(specifier).toBe('./users.zod');
    expect(await reachedIn(file, specifier, false)).toEqual([
      'bundler/esm',
      'bundler/cjs',
      'node10/esm',
      'node10/cjs',
      'node16/cjs',
      'nodenext/cjs',
    ]);
  });

  // 'ts' costs a compiler flag, which is why it is not the default, but it is the only form
  // Node's own type stripping accepts, so a project that runs the generated .ts unbuilt
  // needs it.
  it('reaches the emitted file in every cell with ts', async () => {
    const file = moduleFileName('users', '.zod.ts');
    const specifier = moduleSpecifier('users', '.zod.ts', 'ts');
    expect(specifier).toBe('./users.zod.ts');
    expect(await reachedIn(file, specifier, true)).toEqual(CELLS);
    // The resolver finds the file either way. What `allowImportingTsExtensions` adds is the
    // checker's permission to name it: without the flag tsc reports TS5097 on the specifier
    // even though it resolved, which is the reason 'ts' is not the default.
    expect(await reachedIn(file, specifier, false)).toEqual(CELLS);
  });

  it('offers exactly the three documented values', () => {
    expect(IMPORT_EXTENSIONS).toEqual(['js', 'none', 'ts']);
  });

  it('leaves a path alone when it names no TypeScript file', () => {
    for (const ext of IMPORT_EXTENSIONS) {
      expect(importSpecifier('./users.zod', ext)).toBe('./users.zod');
      expect(moduleSpecifier('users', '.zod', ext)).toBe('./users.zod');
    }
  });

  it('rewrites a nested path, not just a sibling', () => {
    expect(importSpecifier('./types/users.ts')).toBe('./types/users.js');
    expect(importSpecifier('./types/users.ts', 'none')).toBe('./types/users');
    expect(importSpecifier('./types/users.ts', 'ts')).toBe('./types/users.ts');
  });

  it('keeps every fileSuffix shape working under each value', () => {
    const cases: [string, Record<ImportExtension, string>][] = [
      ['.zod.ts', { js: './users.zod.js', none: './users.zod', ts: './users.zod.ts' }],
      ['Schema.ts', { js: './usersSchema.js', none: './usersSchema', ts: './usersSchema.ts' }],
      ['.ts', { js: './users.js', none: './users', ts: './users.ts' }],
      ['.zod.tsx', { js: './users.zod.js', none: './users.zod', ts: './users.zod.tsx' }],
      // Extensionless reaches neither .mts nor .cts, so 'none' still has to spell one.
      ['.zod.mts', { js: './users.zod.mjs', none: './users.zod.mjs', ts: './users.zod.mts' }],
      ['.zod.cts', { js: './users.zod.cjs', none: './users.zod.cjs', ts: './users.zod.cts' }],
    ];
    for (const [suffix, expected] of cases) {
      for (const ext of IMPORT_EXTENSIONS) {
        expect(moduleSpecifier('users', suffix, ext), `${suffix} as ${ext}`).toBe(expected[ext]);
      }
    }
  });
});
