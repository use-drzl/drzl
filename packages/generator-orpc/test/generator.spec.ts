import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('@drzl/generator-orpc', () => {
  it('generates router with shared Zod schemas', async () => {
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
          unique: [{ columns: ['email'] }],
          indexes: [],
        } as any,
      ],
      enums: [],
      relations: [],
      issues: [],
    };

    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-'));
    try {
      const gen = new ORPCGenerator(analysis);
      const { files } = await gen.generate({ outputDir: outDir, template: 'standard' });
      // one router file + index barrel
      expect(files.length).toBe(2);
      const routerFile = files.find((f) => /users/i.test(path.basename(f))) ?? files[0];
      const content = await fs.readFile(routerFile, 'utf8');
      expect(content).toContain('export const Insertusers');
      expect(content).toContain('export const Updateusers');
      expect(content).toContain('export const Selectusers');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('attaches output schemas for valibot and arktype', async () => {
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
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-out-'));
    try {
      // valibot
      let gen = new ORPCGenerator(analysis);
      let res = await gen.generate({
        outputDir: outDir,
        template: 'standard',
        validation: { library: 'valibot' },
      });
      let routerFile = res.files.find((f) => /users/i.test(path.basename(f))) ?? res.files[0];
      let content = await fs.readFile(routerFile, 'utf8');
      expect(content).toContain('.output(v.');
      // arktype
      gen = new ORPCGenerator(analysis);
      res = await gen.generate({
        outputDir: outDir,
        template: 'standard',
        validation: { library: 'arktype' },
      });
      routerFile = res.files.find((f) => /users/i.test(path.basename(f))) ?? res.files[0];
      content = await fs.readFile(routerFile, 'utf8');
      expect(content).toContain('.output(SelectusersSchema');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
