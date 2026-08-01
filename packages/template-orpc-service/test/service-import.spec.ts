/**
 * The service import this template emits has to be a specifier Node and tsc can actually
 * resolve. It was neither.
 *
 * Two defects in one hand-built string, both found against published 2.2.0:
 *
 *   import { PostService } from "../api-services/postService";   // no .js, fails under nodenext
 *   import { PostService } from "services/postService";          // no ./, resolves as a package
 *
 * The second is the worse of the two. `path.relative` returns `services` with no leading `./`
 * whenever the services directory sits inside the router's output directory, and a specifier
 * without `./` is a bare specifier: Node looks for a *package* named `services` in node_modules
 * and never considers the file next door.
 *
 * The barrel emitted alongside these routers has always spelled `./posts.js` correctly, because
 * it goes through `importSpecifier`. This one built the string by hand.
 */
import { describe, it, expect } from 'vitest';
import hooks from '../src/index';
import path from 'node:path';

const table = { name: 'posts', tsName: 'posts' } as any;

/** The specifier of the service import, as emitted. */
function serviceSpecifier(ctx: Record<string, unknown>): string {
  const out = hooks.imports?.([table], ctx as any) ?? '';
  const m = out.match(/from\s+'([^']*[Ss]ervice[^']*)'/);
  expect(m, `no service import found in:\n${out}`).toBeTruthy();
  return m![1];
}

describe('the service import specifier', () => {
  it('ends in .js so it resolves under node16 and nodenext', () => {
    const spec = serviceSpecifier({
      outDir: path.resolve('/tmp/app/src/api'),
      servicesDir: path.resolve('/tmp/app/src/services'),
    });
    expect(spec).toMatch(/\.js$/);
  });

  it('stays relative when the services directory sits inside the output directory', () => {
    // path.relative returns a bare `services` here. Emitted as is, Node resolves it as a
    // package name and the local directory is never consulted.
    const spec = serviceSpecifier({
      outDir: path.resolve('/tmp/app/src/api'),
      servicesDir: path.resolve('/tmp/app/src/api/services'),
    });
    expect(spec.startsWith('./'), `expected a relative specifier, got '${spec}'`).toBe(true);
    expect(spec).toBe('./services/postService.js');
  });

  it('walks up correctly when the services directory is a sibling', () => {
    const spec = serviceSpecifier({
      outDir: path.resolve('/tmp/app/src/api'),
      servicesDir: path.resolve('/tmp/app/src/api-services'),
    });
    expect(spec).toBe('../api-services/postService.js');
  });

  it('honours importExtension: none, for consumers who spelled it that way before 2.0', () => {
    const spec = serviceSpecifier({
      outDir: path.resolve('/tmp/app/src/api'),
      servicesDir: path.resolve('/tmp/app/src/services'),
      importExtension: 'none',
    });
    expect(spec).toBe('../services/postService');
  });

  it('emits a resolvable specifier in database injection mode too', () => {
    const spec = serviceSpecifier({
      outDir: path.resolve('/tmp/app/src/api'),
      servicesDir: path.resolve('/tmp/app/src/api/services'),
      databaseInjection: { enabled: true, databaseType: 'Database' },
    });
    expect(spec).toBe('./services/postService.js');
  });

  it('defaults to src/services when nothing is passed, still relative and extensioned', () => {
    const spec = serviceSpecifier({ outDir: path.resolve(process.cwd(), 'src/api') });
    expect(spec).toBe('../services/postService.js');
  });
});
