import { describe, it, expect } from 'vitest';
import { insertColumns, updateColumns, selectColumns, type Table } from '../src';

describe('@drzl/validation-core helpers', () => {
  const table: Table = {
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
      {
        name: 'bio',
        tsType: 'string',
        dbType: 'TEXT',
        nullable: true,
        hasDefault: false,
        isGenerated: false,
      },
    ],
    primaryKey: { columns: ['id'] },
  };

  it('insertColumns omits PK/generated', () => {
    const cols = insertColumns(table);
    expect(cols.some((c) => c.name === 'id')).toBe(false);
    expect(cols.some((c) => c.name === 'email')).toBe(true);
  });

  it('updateColumns includes non-PK fields', () => {
    const cols = updateColumns(table);
    expect(cols.some((c) => c.name === 'id')).toBe(false);
    expect(cols.some((c) => c.name === 'bio')).toBe(true);
  });

  it('selectColumns returns all', () => {
    const cols = selectColumns(table);
    expect(cols.length).toBe(3);
  });
});
