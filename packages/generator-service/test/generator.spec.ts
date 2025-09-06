import { describe, it, expect } from 'vitest';
import { ServiceGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('@drzl/generator-service', () => {
  it('generates service types and class (stub)', async () => {
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
          primaryKey: { columns: ['id'] },
        } as any,
      ],
      enums: [],
      relations: [],
      issues: [],
    };
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-svc-'));
    try {
      const gen = new ServiceGenerator(analysis);
      const files = await gen.generate({ outDir, dataAccess: 'stub' });
      const svcFile = files.find((f) => /Service\.ts$/.test(f));
      const typesFile = files.find((f) => /types\/users\.ts$/.test(f));
      expect(svcFile).toBeTruthy();
      expect(typesFile).toBeTruthy();
      const svcContent = await fs.readFile(svcFile!, 'utf8');
      expect(svcContent).toContain('class UserService');
      expect(svcContent).toContain('static async getAll');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
