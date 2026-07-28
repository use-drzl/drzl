import type { Analysis } from '@drzl/analyzer';
import { ArkTypeGenerator } from '@drzl/generator-arktype';
import { ORPCGenerator } from '@drzl/generator-orpc';
import { ValibotGenerator } from '@drzl/generator-valibot';
import { ZodGenerator } from '@drzl/generator-zod';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, resolveConfig } from '../src/config';

// The CLI is the only package that depends on every generator, so it is the only place a
// cross-package name contract can be tested. Contract A: the oRPC router imports
// Insert/Update/Select schemas from the validation generator's barrel. Both sides build
// those names by string concatenation, so nothing but a test keeps them in agreement.

const analysis: Analysis = {
  dialect: 'sqlite',
  tables: [
    {
      name: 'user_profiles',
      tsName: 'userProfiles',
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
      primaryKey: { columns: ['id'] },
    } as any,
    {
      name: 'addresses',
      tsName: 'addresses',
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
          name: 'line1',
          tsType: 'string',
          dbType: 'TEXT',
          nullable: false,
          hasDefault: false,
          isGenerated: false,
        },
      ],
      unique: [],
      indexes: [],
      primaryKey: { columns: ['id'] },
    } as any,
  ],
  enums: [],
  relations: [],
  issues: [],
};

const GENERATORS = {
  zod: ZodGenerator,
  valibot: ValibotGenerator,
  arktype: ArkTypeGenerator,
} as const;

/** Every `export const X` emitted by the validation generator, across all of its files. */
async function exportedConsts(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const entry of await fs.readdir(dir)) {
    const code = await fs.readFile(path.join(dir, entry), 'utf8');
    for (const m of code.matchAll(/export const ([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(m[1]);
  }
  return names;
}

/** Names the router pulls out of `importPath`, i.e. the left side of each `X as Y`. */
function importedFrom(code: string, importPath: string): string[] {
  const re = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`
  );
  const m = code.match(re);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) =>
      s
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
    )
    .filter(Boolean);
}

async function runPair(library: 'zod' | 'valibot' | 'arktype', affix: unknown) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-contract-'));
  const validatorsDir = path.join(root, 'validators', library);
  const apiDir = path.join(root, 'api');

  const parsed = ConfigSchema.parse({
    schema: 'src/db/schema.ts',
    outDir: apiDir,
    generators: [
      { kind: library, path: validatorsDir, ...(affix ? { affix } : {}) },
      {
        kind: 'orpc',
        template: 'standard',
        validation: { useShared: true, library, importPath: '../validators/' + library },
      },
    ],
  });
  const { config } = resolveConfig(parsed);

  const vgen = config.generators.find((g) => g.kind === library)!;
  await new (GENERATORS[library] as any)(analysis).generate({
    outDir: validatorsDir,
    affix: vgen.affix,
    schemaSuffix: vgen.schemaSuffix,
  });

  const orpc = config.generators.find((g) => g.kind === 'orpc')!;
  const { files } = await new ORPCGenerator(analysis).generate({
    outputDir: apiDir,
    template: 'standard',
    validation: orpc.validation,
  });

  return { root, validatorsDir, files, importPath: '../validators/' + library };
}

describe('cross-package naming contract: orpc router <-> validation generator', () => {
  for (const library of ['zod', 'valibot', 'arktype'] as const) {
    it(`${library}: every name the router imports is exported by the generator (default naming)`, async () => {
      const { root, validatorsDir, files, importPath } = await runPair(library, undefined);
      try {
        const exported = await exportedConsts(validatorsDir);
        const routers = files.filter((f) => !f.endsWith(path.sep + 'index.ts'));
        expect(routers.length).toBe(2);
        for (const f of routers) {
          const imported = importedFrom(await fs.readFile(f, 'utf8'), importPath);
          expect(imported.length).toBe(3);
          for (const name of imported) expect([...exported]).toContain(name);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it(`${library}: the same holds once an affix is configured on the validation generator only`, async () => {
      const affix = {
        tableCase: 'pascal',
        schema: { prefix: { insert: 'Create', update: 'Edit', select: 'Get' }, suffix: 'Doc' },
        type: { prefix: { select: '' }, suffix: { select: '' } },
      };
      const { root, validatorsDir, files, importPath } = await runPair(library, affix);
      try {
        const exported = await exportedConsts(validatorsDir);
        expect(exported.has('CreateUserProfilesDoc')).toBe(true);
        expect(exported.has('GetAddressesDoc')).toBe(true);
        const routers = files.filter((f) => !f.endsWith(path.sep + 'index.ts'));
        for (const f of routers) {
          const imported = importedFrom(await fs.readFile(f, 'utf8'), importPath);
          expect(imported.length).toBe(3);
          for (const name of imported) expect([...exported]).toContain(name);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
