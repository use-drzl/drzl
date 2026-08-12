/**
 * What the client generator emits, against a schema built here rather than a fixture on disk.
 *
 * The compile spec beside this one proves the emitted module typechecks against real
 * `openapi-fetch`. This file is the cheaper half: that the paths, verbs, parameters and response
 * statuses in the emitted type are the ones the document declares, and that the two cannot drift,
 * because both come from `openApiDocument`.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { OpenApiFetchGenerator } from '../src/index.js';

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(name: string, over: Partial<Table> = {}): Table {
  return {
    name,
    tsName: name,
    unique: [],
    indexes: [],
    columns: [
      col('id', 'number', { sqlType: 'integer' }),
      col('email', 'string', { sqlType: 'text' }),
      col('nickname', 'string', { sqlType: 'text', nullable: true }),
    ],
    primaryKey: { columns: ['id'] },
    ...over,
  } as Table;
}

function analysis(tables: Table[]): Analysis {
  return { dialect: 'postgres', tables, enums: [], relations: [], issues: [] } as Analysis;
}

/** Run the generator against an in-memory sink and return the one file it wrote. */
async function emit(a: Analysis, over: Record<string, unknown> = {}): Promise<string> {
  const files = new Map<string, string>();
  await new OpenApiFetchGenerator(a).generate({
    outputDir: '/virtual/out',
    validation: { useShared: true, importPath: '../zod' },
    format: { enabled: false },
    fileSink: {
      mkdir: async () => undefined,
      writeFile: async (p: string, content: string) => {
        files.set(p, content);
      },
    } as never,
    ...over,
  } as never);
  const [only] = [...files.values()];
  return only ?? '';
}

describe('the emitted client', () => {
  it('declares every path the document declares, and no other', async () => {
    const code = await emit(analysis([table('users')]));
    expect(code).toContain('"/users": {');
    expect(code).toContain('"/users/{id}": {');
    // A path the document does not describe must not appear, however plausible it looks.
    expect(code).not.toContain('"/user"');
  });

  it('puts each verb where the document puts it', async () => {
    const code = await emit(analysis([table('users')]));
    const collection = code.slice(code.indexOf('"/users": {'), code.indexOf('"/users/{id}"'));
    expect(collection).toContain('get: {');
    expect(collection).toContain('post: {');
    // The collection path has no single row to address, so neither of these belongs on it.
    expect(collection).not.toContain('patch: {');
    expect(collection).not.toContain('delete: {');
  });

  it('types the path parameter from the real primary key, not as a string', async () => {
    const code = await emit(analysis([table('users')]));
    expect(code).toMatch(/"id": number;/);
  });

  it('types a text primary key as a string', async () => {
    const t = table('slugs', {
      columns: [col('slug', 'string', { sqlType: 'text' }), col('body', 'string')],
      primaryKey: { columns: ['slug'] },
    });
    const code = await emit(analysis([t]));
    expect(code).toMatch(/"slug": string;/);
  });

  /**
   * The measurement this generator exists to act on: with only a 200 declared, `result.error` has
   * no readable shape and every caller has to cast. The document already declares the others.
   */
  it('carries the error statuses, not just the success ones', async () => {
    const code = await emit(analysis([table('users')]));
    expect(code).toContain('404:');
    expect(code).toContain('400:');
    expect(code).toContain('ApiError');
  });

  it('gives a 204 no content rather than leaving the status out', async () => {
    const code = await emit(analysis([table('users')]));
    expect(code).toContain('204: { content: never };');
  });

  it('imports exactly the row types it uses, from the configured path', async () => {
    const code = await emit(analysis([table('users')]));
    expect(code).toMatch(/import type \{[^}]*\} from "\.\.\/zod\/index\.js"/);
    expect(code).toContain('InsertusersInput');
    expect(code).toContain('SelectusersOutput');
    expect(code).toContain('UpdateusersInput');
  });

  it('emits no insert or update for a read-only relation', async () => {
    const view = table('reports', { readOnly: true });
    const code = await emit(analysis([view]));
    expect(code).toContain('"/reports": {');
    expect(code).not.toContain('InsertreportsInput');
    expect(code).not.toContain('UpdatereportsInput');
    // And the import list must not name them either, or the emitted file references an export the
    // validation output never wrote.
    const importLine = code.slice(code.indexOf('import type'), code.indexOf(';', code.indexOf('import type')));
    expect(importLine).not.toContain('Insert');
  });

  it('addresses no single row for a table with no primary key', async () => {
    const t = table('events', {
      columns: [col('kind', 'string'), col('at', 'string')],
      primaryKey: undefined,
    });
    const code = await emit(analysis([t]));
    expect(code).toContain('"/events": {');
    expect(code).not.toContain('"/events/{');
  });
});

describe('what it refuses', () => {
  it('refuses without validation.importPath, rather than typing the API as unknown', async () => {
    await expect(
      emit(analysis([table('users')]), { validation: { useShared: true } })
    ).rejects.toThrow(/validation\.importPath/);
  });

  it('refuses without validation.useShared', async () => {
    await expect(
      emit(analysis([table('users')]), { validation: { importPath: '../zod' } })
    ).rejects.toThrow(/useShared/);
  });

  it('refuses a schema with no table rather than emitting an empty client', async () => {
    await expect(emit(analysis([]))).rejects.toThrow(/no path/);
  });
});
