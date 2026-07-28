import type { Analysis } from '@drzl/analyzer';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValibotGenerator } from '../src';

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
 * The file names a TypeScript import of `spec` is allowed to reach, as verified against
 * tsc with moduleResolution bundler, node10 and node16:
 *  - an extensionless specifier reaches `.ts` and `.tsx`, and never `.mts` or `.cts`
 *  - `.mjs` reaches `.mts`, `.cjs` reaches `.cts`
 */
function candidates(spec: string): string[] {
  const base = spec.replace(/^\.\//, '');
  if (base.endsWith('.mjs')) return [base.slice(0, -4) + '.mts'];
  if (base.endsWith('.cjs')) return [base.slice(0, -4) + '.cts'];
  return [base + '.ts', base + '.tsx'];
}

async function generateInto(fileSuffix?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'drzl-valibot-barrel-'));
  await new ValibotGenerator(analysis).generate({
    outDir: dir,
    fileSuffix,
    format: { enabled: false },
  });
  const barrel = await readFile(join(dir, 'index.ts'), 'utf8');
  return { dir, barrel, entries: await readdir(dir) };
}

describe('@drzl/generator-valibot barrel', () => {
  const cases: { fileSuffix?: string; file: string; specifier: string; importable?: boolean }[] = [
    { fileSuffix: undefined, file: 'users.valibot.ts', specifier: './users.valibot' },
    { fileSuffix: '.schema.ts', file: 'users.schema.ts', specifier: './users.schema' },
    // No leading dot: the suffix runs straight onto the table name.
    { fileSuffix: 'Schema.ts', file: 'usersSchema.ts', specifier: './usersSchema' },
    // Nothing but an extension.
    { fileSuffix: '.ts', file: 'users.ts', specifier: './users' },
    { fileSuffix: '.valibot.tsx', file: 'users.valibot.tsx', specifier: './users.valibot' },
    // .mts and .cts are unreachable extensionless, so the specifier takes the output
    // extension instead. That form also resolves under node16/nodenext.
    { fileSuffix: '.valibot.mts', file: 'users.valibot.mts', specifier: './users.valibot.mjs' },
    { fileSuffix: '.valibot.cts', file: 'users.valibot.cts', specifier: './users.valibot.cjs' },
    // Not a TypeScript extension at all. Nothing can import such a file, but the barrel
    // still has to name the file that was written rather than invent another one.
    {
      fileSuffix: '.valibot',
      file: 'users.valibot',
      specifier: './users.valibot',
      importable: false,
    },
  ];

  for (const c of cases) {
    const label = c.fileSuffix === undefined ? 'the default suffix' : `fileSuffix ${c.fileSuffix}`;
    it(`points at a file that exists with ${label}`, async () => {
      const { dir, barrel, entries } = await generateInto(c.fileSuffix);
      try {
        expect(entries.sort()).toEqual(['index.ts', c.file].sort());
        expect(specifiers(barrel)).toEqual([c.specifier]);
        if (c.importable === false) {
          // Nothing to resolve, so all that is left to check is that the barrel names the
          // file that was written.
          expect(c.specifier).toBe(`./${c.file}`);
          return;
        }
        const reached = candidates(c.specifier).filter((f) => existsSync(join(dir, f)));
        expect(reached).toEqual([c.file]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
