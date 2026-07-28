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

  it('honours affix prefixes, suffixes and tableCase', async () => {
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
        } as any,
      ],
      enums: [],
      relations: [],
      issues: [],
    };
    const gen = new ZodGenerator(analysis);
    const code = gen.renderTable(analysis.tables[0], {
      outDir: 'x',
      affix: {
        tableCase: 'pascal',
        schema: { suffix: 'Schema' },
        type: {
          prefix: { insert: 'Create', update: 'Edit', select: '' },
          suffix: { insert: 'Input', update: 'Input', select: '' },
        },
      },
    });
    expect(code).toContain('export const InsertUserProfilesSchema');
    expect(code).toContain('export const UpdateUserProfilesSchema');
    expect(code).toContain('export const SelectUserProfilesSchema');
    expect(code).toContain(
      'export type CreateUserProfilesInput = z.input<typeof InsertUserProfilesSchema>;'
    );
    expect(code).toContain(
      'export type EditUserProfilesInput = z.input<typeof UpdateUserProfilesSchema>;'
    );
    expect(code).toContain('export type UserProfiles = z.output<typeof SelectUserProfilesSchema>;');
  });
});
