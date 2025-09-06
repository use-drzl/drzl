import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';

describe('@drzl/generator-zod', () => {
  it('renders zod schemas for a simple table', async () => {
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
    const gen = new ZodGenerator(analysis);
    const code = gen.renderTable(analysis.tables[0]);
    expect(code).toContain('import { z } from');
    expect(code).toContain('export const InsertusersSchema');
    expect(code).toContain('export const UpdateusersSchema');
    expect(code).toContain('export const SelectusersSchema');
  });
});
