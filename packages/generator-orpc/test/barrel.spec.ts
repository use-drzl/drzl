import type { Analysis } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORPCGenerator } from '../src';

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

/** Every `from '...'` specifier the router barrel imports from, in order. */
function specifiers(barrel: string): string[] {
  return [...barrel.matchAll(/import \{[^}]*\} from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

async function generateInto(importExtension?: ImportExtension) {
  const dir = await mkdtemp(join(tmpdir(), 'drzl-orpc-barrel-'));
  await new ORPCGenerator(analysis).generate({
    outputDir: dir,
    template: 'standard',
    importExtension,
    format: { enabled: false },
  });
  return { dir, barrel: await readFile(join(dir, 'index.ts'), 'utf8') };
}

describe('@drzl/generator-orpc barrel', () => {
  const cases: [ImportExtension | undefined, string][] = [
    // Unset has to behave exactly like 'js'.
    [undefined, './users.js'],
    ['js', './users.js'],
    ['none', './users'],
    ['ts', './users.ts'],
  ];

  for (const [importExtension, expected] of cases) {
    it(`imports the router file it wrote with importExtension ${importExtension ?? 'unset'}`, async () => {
      const { dir, barrel } = await generateInto(importExtension);
      try {
        expect(specifiers(barrel)).toEqual([expected]);
        // Whatever the specifier spells, it has to land on the file that exists.
        expect(existsSync(join(dir, 'users.ts'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('emits the .js form the default promises', async () => {
    const { dir, barrel } = await generateInto();
    try {
      expect(barrel).toContain("from './users.js'");
      expect(barrel).not.toContain("from './users'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
