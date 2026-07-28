import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';

describe('@drzl/generator-valibot', () => {
  it('renders valibot schemas for a simple table', async () => {
    const analysis: Analysis = {
      dialect: 'sqlite',
      tables: [
        {
          name: 'posts',
          tsName: 'posts',
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
              name: 'title',
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
    const gen = new ValibotGenerator(analysis);
    const code = gen.renderTable(analysis.tables[0]);
    expect(code).toContain("import * as v from 'valibot'");
    expect(code).toContain('export const InsertpostsSchema');
    expect(code).toContain('export const UpdatepostsSchema');
    expect(code).toContain('export const SelectpostsSchema');
  });

  it('honours affix prefixes, suffixes and tableCase', async () => {
    const analysis: Analysis = {
      dialect: 'sqlite',
      tables: [
        {
          name: 'blog_posts',
          tsName: 'blogPosts',
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
              name: 'title',
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
    const gen = new ValibotGenerator(analysis);
    const code = gen.renderTable(analysis.tables[0], {
      outDir: 'x',
      affix: {
        tableCase: 'pascal',
        schema: { prefix: { insert: 'Create' }, suffix: 'Doc' },
        type: { suffix: { select: '' }, prefix: { select: '' } },
      },
    });
    expect(code).toContain('export const CreateBlogPostsDoc');
    expect(code).toContain('export const UpdateBlogPostsDoc');
    expect(code).toContain('export const SelectBlogPostsDoc');
    expect(code).toContain(
      'export type InsertBlogPostsInput = InferInput<typeof CreateBlogPostsDoc>;'
    );
    expect(code).toContain('export type BlogPosts = InferOutput<typeof SelectBlogPostsDoc>;');
  });
});
