import { describe, it, expect } from 'vitest';
import hooks from '../src/index';
import path from 'node:path';

describe('@drzl/template-orpc-service', () => {
  const table = { name: 'users', tsName: 'users' } as any;

  it('applies routerSuffix to routerName', () => {
    const r = hooks.routerName(table, { naming: { routerSuffix: 'Router' } });
    expect(r).toBe('usersRouter');
  });

  it('imports path points to services dir relative to outDir', () => {
    const out = path.resolve('/tmp/api');
    const imp = hooks.imports?.([table], { outDir: out, servicesDir: '/tmp/api/services' } as any);
    expect(imp).toContain("from 'services/userService'");
  });
});
