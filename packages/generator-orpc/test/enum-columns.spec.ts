import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Enum values and column names were interpolated into the emitted code with hand-written quotes.
 *
 * Measured, not assumed. A plain enum such as `['admin', 'user']` was fine. What broke the run was
 * an enum value containing an apostrophe, or a column name that is not a bare identifier: both
 * emitted unparseable code, prettier threw while formatting it, and the whole generate run aborted
 * rather than failing on just that column.
 *
 * The three standalone validation generators already escaped both. This path did not, and no fixture
 * here had an enum column at all, which is why nothing caught it.
 *
 * The `''` assertions below are guards rather than reproductions: a doubled-quote defect was
 * suspected in the arktype branch, but it did not reproduce through this route, since the standard
 * template renders zod expressions regardless of the configured lib. The guards are kept because
 * they are free and would catch it if that branch is ever reached.
 */
const analysisWith = (enumValues: string[], columnName = 'role'): Analysis =>
  ({
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
            name: columnName,
            tsType: 'string',
            dbType: 'TEXT',
            nullable: false,
            hasDefault: false,
            isGenerated: false,
            enumValues,
          },
        ],
        unique: [],
        indexes: [],
      } as any,
    ],
    enums: [],
    relations: [],
    issues: [],
  }) as Analysis;

async function generate(analysis: Analysis, lib: 'zod' | 'valibot' | 'arktype') {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-enum-'));
  try {
    const gen = new ORPCGenerator(analysis);
    const { files } = await gen.generate({
      outputDir: outDir,
      template: 'standard',
      validation: { lib, importPath: './validation', useShared: false },
    } as any);
    const routerFile = files.find((f) => /users/i.test(path.basename(f))) ?? files[0];
    return await fs.readFile(routerFile, 'utf8');
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

describe('@drzl/generator-orpc enum columns', () => {
  for (const lib of ['zod', 'valibot', 'arktype'] as const) {
    it(`generates at all for a plain enum column (${lib})`, async () => {
      // A regression guard, not a reproduction: this case passed before the fix too. It is here so
      // that ordinary enum columns, which no other fixture covers, cannot quietly break later.
      const content = await generate(analysisWith(['admin', 'user']), lib);
      expect(content).toContain('admin');
      expect(content).toContain('user');
      expect(content).not.toContain("''");
    });

    it(`escapes an apostrophe inside an enum value (${lib})`, async () => {
      const content = await generate(analysisWith(['admin', "o'brien"]), lib);
      // The value must survive, and it must not sit in the output as a bare unescaped quote that
      // closes the string early.
      expect(content).toMatch(/o(\\'|')brien/);
      expect(content).not.toContain("'o'brien'");
    });
  }

  it('quotes a column name that is not a bare identifier', async () => {
    const content = await generate(analysisWith(['a', 'b'], 'odd name'), 'zod');
    expect(content).toContain('"odd name"');
  });
});
