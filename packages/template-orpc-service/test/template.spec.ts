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
    // Was asserted as `from 'services/userService'`, which pinned two defects in place: no
    // leading `./`, making it a bare specifier Node resolves as a package, and no extension,
    // which fails under moduleResolution node16 and nodenext. See service-import.spec.ts.
    expect(imp).toContain("from './services/userService.js'");
  });
});
