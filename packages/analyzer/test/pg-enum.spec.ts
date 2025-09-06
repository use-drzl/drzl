import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Analyzer pgEnum detection', () => {
  it('detects enumName + enumValues export', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'pg-enum.mjs');
    const code = `export const statusEnum = { enumName: 'status', enumValues: ['draft','published','archived'] };`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    expect(res.enums.some((e) => e.name === 'status' && e.values.includes('draft'))).toBe(true);
  });
});
