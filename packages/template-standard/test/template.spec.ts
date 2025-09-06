import { describe, it, expect } from 'vitest';
import hooks from '../src/index';
import os from 'node:os';
import path from 'node:path';

describe('@drzl/template-standard', () => {
  const table = { name: 'users', tsName: 'users' } as any;

  it('applies routerSuffix and kebab case to filePath', () => {
    const tmpDir = path.join(os.tmpdir(), 'drzl-template-');
    const p = hooks.filePath(table, {
      outDir: tmpDir,
      naming: { routerSuffix: 'Router', procedureCase: 'kebab' },
    });
    expect(p.endsWith('/users-router.ts')).toBe(true);
  });

  it('applies routerSuffix to routerName', () => {
    const r = hooks.routerName(table, { naming: { routerSuffix: 'Router' } });
    expect(r).toBe('usersRouter');
  });
});
