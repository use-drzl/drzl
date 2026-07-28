import type { Analysis } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodGenerator } from '../src';

const analysis: Analysis = {
  dialect: 'sqlite',
  tables: [
    {
      name: 'users',
      tsName: 'users',
      columns: [
        {
          name: 'id',
          tsType: 'number',
          dbType: 'INTEGER',
          nullable: false,
          hasDefault: true,
          isGenerated: true,
        },
        {
          name: 'email',
          tsType: 'string',
          dbType: 'TEXT',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
        },
      ],
      unique: [],
      indexes: [],
    } as any,
  ],
  enums: [],
  relations: [],
  issues: [],
};

/** Every `export * from '...'` specifier the barrel emits, in order. */
function specifiers(barrel: string): string[] {
  return [...barrel.matchAll(/export \* from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * The file names a TypeScript import of `spec` is allowed to reach. Encodes what
 * `@drzl/validation-core` measures against TypeScript's own resolver in
 * `import-extension.spec.ts`:
 *  - `.js` reaches `.ts` and `.tsx`, `.mjs` reaches `.mts`, `.cjs` reaches `.cts`
 *  - an extensionless specifier reaches `.ts` and `.tsx`, and never `.mts` or `.cts`
 *  - a `.ts`/`.tsx`/`.mts`/`.cts` specifier reaches only its own file
 */
function candidates(spec: string): string[] {
  const base = spec.replace(/^\.\//, '');
  if (base.endsWith('.mjs')) return [base.slice(0, -4) + '.mts'];
  if (base.endsWith('.cjs')) return [base.slice(0, -4) + '.cts'];
  if (base.endsWith('.js')) return [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx'];
  if (/\.(m|c)?tsx?$/.test(base)) return [base];
  return [base + '.ts', base + '.tsx'];
}

async function generateInto(fileSuffix?: string, importExtension?: ImportExtension) {
  const dir = await mkdtemp(join(tmpdir(), 'drzl-zod-barrel-'));
  await new ZodGenerator(analysis).generate({
    outDir: dir,
    fileSuffix,
    importExtension,
    format: { enabled: false },
  });
  const barrel = await readFile(join(dir, 'index.ts'), 'utf8');
  return { dir, barrel, entries: await readdir(dir) };
}

type Case = {
  fileSuffix?: string;
  file: string;
  /** Per importExtension; `undefined` is the default and has to match `js`. */
  specifier: Record<ImportExtension, string>;
  importable?: boolean;
};

describe('@drzl/generator-zod barrel', () => {
  const cases: Case[] = [
    {
      fileSuffix: undefined,
      file: 'users.zod.ts',
      specifier: {
        js: './users.zod.js',
        none: './users.zod',
        ts: './users.zod.ts',
      },
    },
    {
      fileSuffix: '.schema.ts',
      file: 'users.schema.ts',
      specifier: { js: './users.schema.js', none: './users.schema', ts: './users.schema.ts' },
    },
    // No leading dot: the suffix runs straight onto the table name.
    {
      fileSuffix: 'Schema.ts',
      file: 'usersSchema.ts',
      specifier: { js: './usersSchema.js', none: './usersSchema', ts: './usersSchema.ts' },
    },
    // Nothing but an extension.
    {
      fileSuffix: '.ts',
      file: 'users.ts',
      specifier: { js: './users.js', none: './users', ts: './users.ts' },
    },
    {
      fileSuffix: '.zod.tsx',
      file: 'users.zod.tsx',
      specifier: {
        js: './users.zod.js',
        none: './users.zod',
        ts: './users.zod.tsx',
      },
    },
    // .mts and .cts are unreachable extensionless, so even `none` spells the output
    // extension.
    {
      fileSuffix: '.zod.mts',
      file: 'users.zod.mts',
      specifier: {
        js: './users.zod.mjs',
        none: './users.zod.mjs',
        ts: './users.zod.mts',
      },
    },
    {
      fileSuffix: '.zod.cts',
      file: 'users.zod.cts',
      specifier: {
        js: './users.zod.cjs',
        none: './users.zod.cjs',
        ts: './users.zod.cts',
      },
    },
    // Not a TypeScript extension at all. Nothing can import such a file, but the barrel
    // still has to name the file that was written rather than invent another one.
    {
      fileSuffix: '.zod',
      file: 'users.zod',
      specifier: {
        js: './users.zod',
        none: './users.zod',
        ts: './users.zod',
      },
      importable: false,
    },
  ];

  async function check(c: Case, expected: string, importExtension?: ImportExtension) {
    const { dir, barrel, entries } = await generateInto(c.fileSuffix, importExtension);
    try {
      expect(entries.sort()).toEqual(['index.ts', c.file].sort());
      expect(specifiers(barrel)).toEqual([expected]);
      if (c.importable === false) {
        // Nothing to resolve, so all that is left to check is that the barrel names the
        // file that was written.
        expect(expected).toBe(`./${c.file}`);
        return;
      }
      const reached = candidates(expected).filter((f) => existsSync(join(dir, f)));
      expect(reached).toEqual([c.file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  for (const c of cases) {
    const label = c.fileSuffix === undefined ? 'the default suffix' : `fileSuffix ${c.fileSuffix}`;
    it(`points at a file that exists with ${label}`, async () => {
      // Leaving importExtension unset has to behave exactly like asking for 'js'.
      await check(c, c.specifier.js);
      await check(c, c.specifier.js, 'js');
    });

    it(`follows importExtension with ${label}`, async () => {
      await check(c, c.specifier.none, 'none');
      await check(c, c.specifier.ts, 'ts');
    });
  }

  it('emits the .js form the default promises', async () => {
    const { barrel } = await generateInto();
    expect(barrel).toContain("export * from './users.zod.js';");
  });
});
