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

  it('renders enums while escaping quotes in generated output', () => {
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: [
        {
          name: 'users',
          tsName: 'users',
          columns: [
            {
              name: 'role',
              tsType: 'string',
              dbType: 'TEXT',
              enumValues: ['admin', 'cashier', 'he said "hi"'],
              nullable: false,
              hasDefault: false,
              isGenerated: false,
            },
            {
              name: 'status',
              tsType: 'string',
              dbType: 'TEXT',
              enumValues: ['pending', "needs'Escaping"],
              nullable: true,
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

    const expectedRoleLine = `  ${JSON.stringify('role')}: ${JSON.stringify(
      "'admin' | 'cashier' | 'he said \"hi\"'"
    )},`;
    const expectedStatusLine = `  ${JSON.stringify('status')}: ${JSON.stringify(
      "('pending' | 'needs\\'Escaping' | null)?"
    )},`;

    expect(code).toContain(expectedRoleLine);
    expect(code).toContain(expectedStatusLine);
  });
});
