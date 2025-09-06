import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';

describe('@drzl/generator-arktype', () => {
  it('renders arktype schemas for a simple table', async () => {
    const analysis: Analysis = {
      dialect: 'sqlite',
      tables: [
        {
          name: 'comments',
          tsName: 'comments',
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
              name: 'body',
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
    const gen = new ArkTypeGenerator(analysis);
    const code = gen.renderTable(analysis.tables[0]);
    expect(code).toContain("import { type } from 'arktype'");
    expect(code).toContain('export const InsertcommentsSchema');
    expect(code).toContain('export const UpdatecommentsSchema');
    expect(code).toContain('export const SelectcommentsSchema');
  });
});
