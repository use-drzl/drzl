import type { Analysis } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceGenerator } from '../src';

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
      primaryKey: { columns: ['id'] },
      unique: [],
      indexes: [],
    } as any,
  ],
  enums: [],
  relations: [],
  issues: [],
};

/** Every `from '...'` specifier the service file imports types from. */
function typeSpecifiers(service: string): string[] {
  return [...service.matchAll(/import type \{[^}]*\} from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

async function generateInto(importExtension?: ImportExtension) {
  const dir = await mkdtemp(join(tmpdir(), 'drzl-service-ext-'));
  await new ServiceGenerator(analysis).generate({
    outDir: dir,
    dataAccess: 'stub',
    importExtension,
    format: { enabled: false },
  });
  return { dir, service: await readFile(join(dir, 'userService.ts'), 'utf8') };
}

describe('@drzl/generator-service types import', () => {
  const cases: [ImportExtension | undefined, string][] = [
    // Unset has to behave exactly like 'js'.
    [undefined, './types/users.js'],
    ['js', './types/users.js'],
    ['none', './types/users'],
    ['ts', './types/users.ts'],
  ];

  for (const [importExtension, expected] of cases) {
    it(`names the types file it wrote with importExtension ${importExtension ?? 'unset'}`, async () => {
      const { dir, service } = await generateInto(importExtension);
      try {
        expect(typeSpecifiers(service)).toEqual([expected]);
        expect(existsSync(join(dir, 'types', 'users.ts'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('emits the .js form the default promises', async () => {
    const { dir, service } = await generateInto();
    try {
      expect(service).toContain("from './types/users.js'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
