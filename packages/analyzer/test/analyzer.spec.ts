import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '../src/index';

describe('SchemaAnalyzer', () => {
  const tmp = path.resolve(__dirname, 'fixtures');

  it('reports missing schema file with an error', async () => {
    const analyzer = new SchemaAnalyzer(path.join(tmp, 'does-not-exist.ts'));
    const res = await analyzer.analyze();
    expect(res.issues.some((i) => i.code === 'DRZL_ANL_NOFILE' && i.level === 'error')).toBe(true);
  });
});
