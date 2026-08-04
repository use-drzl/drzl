/**
 * A `point` or `line` column in a generated router.
 *
 * This generator maps a column by `tsType` alone, through a switch of four scalar names, so a
 * tuple column fell to `unknown`. On drizzle-orm 0.4x that was invisible until the analyzer began
 * describing those columns correctly: the emitted input schema went from `z.string()`, which
 * refuses the `[1, 2]` the driver returns and accepts a `"1,2"` the column cannot be given, to
 * `z.unknown()`, which accepts anything at all including a null payload the insert will not
 * survive. Neither one is the column. Review caught the second as a loosening that was shipping
 * unmentioned.
 *
 * ArkType keeps `unknown`, measured rather than assumed: its field values are emitted as quoted
 * string-DSL fragments, and `type({ p: '[number, number]' })` throws
 * `Expected an expression before '[number, number]'`. The array-literal form does work and does
 * reject a third element, but it is not a string and so composes with neither the `nullable` nor
 * the `optional` wrapper this generator builds around every field.
 *
 * The option is `validation.library`. `enum-columns.spec.ts` passes `validation.lib`, which this
 * generator does not read, and its docstring puts the resulting zod-only output down to "the
 * standard template renders zod expressions regardless of the configured lib". That is not what is
 * happening: with the key spelled `library` the same template renders valibot and arktype, which
 * is what the three cases below show. Not fixed there, because changing which library that spec
 * exercises is a different change from this one.
 */
import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const analysis: Analysis = {
  dialect: 'postgres',
  tables: [
    {
      name: 'places',
      tsName: 'places',
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
          name: 'at',
          tsType: '[number, number]',
          dbType: 'POINT',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'tuple', length: 2 },
        },
        {
          name: 'edge',
          tsType: '[number, number, number]',
          dbType: 'LINE',
          nullable: true,
          hasDefault: false,
          isGenerated: false,
          shape: { kind: 'tuple', length: 3 },
        },
      ],
      unique: [],
      indexes: [],
    } as never,
  ],
  enums: [],
  relations: [],
  issues: [],
} as Analysis;

async function generate(lib: 'zod' | 'valibot' | 'arktype') {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-tuple-'));
  try {
    const { files } = await new ORPCGenerator(analysis).generate({
      outputDir: outDir,
      template: 'standard',
      validation: { library: lib, importPath: './validation', useShared: false },
    } as never);
    const routerFile = files.find((f) => /places/i.test(path.basename(f))) ?? files[0];
    return await fs.readFile(routerFile, 'utf8');
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

describe('@drzl/generator-orpc tuple columns', () => {
  it('emits a two and a three number tuple for zod', async () => {
    const content = await generate('zod');
    expect(content).toContain('z.tuple([z.number(), z.number()])');
    expect(content).toContain('z.tuple([z.number(), z.number(), z.number()])');
    // The two answers this column has had, neither of which is the column.
    expect(content).not.toContain('"at": z.string()');
    expect(content).not.toContain('"at": z.unknown()');
  });

  it('emits the same for valibot, and keeps the nullable wrapper around it', async () => {
    const content = await generate('valibot');
    expect(content).toContain('v.tuple([v.number(), v.number()])');
    expect(content).toContain('v.nullable(v.tuple([v.number(), v.number(), v.number()]))');
  });

  it('leaves arktype on unknown, because its string DSL has no tuple', async () => {
    // Pinned rather than blessed. If the field emission ever stops JSON-encoding ArkType values,
    // the array-literal form becomes available and this should change with it.
    const content = await generate('arktype');
    expect(content).toContain('unknown');
    expect(content).not.toContain('[number, number]');
  });
});
