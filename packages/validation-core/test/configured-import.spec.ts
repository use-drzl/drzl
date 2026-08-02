/**
 * Configured module paths, e.g. `validation.importPath`, `dbImportPath`, `schemaImportPath`.
 *
 * These were emitted verbatim as import specifiers. Users write them the way the rest of the
 * config names directories, project-relative: `src/validators/zod`. To Node and tsc that is a
 * *bare* specifier naming a package in node_modules, so the local file was never found. The
 * config in docs/guide/getting-started.md produced three imports of that shape and none of them
 * resolved, under bundler or nodenext.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveConfiguredImport } from '../src/files';

const CWD = path.resolve('/project');
const OUT = path.resolve('/project/src/api');

const resolve = (configured: string, ext?: 'js' | 'none' | 'ts') =>
  resolveConfiguredImport(configured, OUT, CWD, ext);

describe('a project-relative path', () => {
  it('becomes a relative specifier with an extension', () => {
    // The exact value from the getting-started guide, which emitted `src/validators/zod`.
    // Nothing exists at that path here, and it carries no extension, so it is taken to be a
    // directory holding a barrel, which is what these options name by convention.
    expect(resolve('src/validators/zod')).toBe('../validators/zod/index.js');
  });

  it('walks down as well as up', () => {
    expect(resolve('src/api/services')).toBe('./services/index.js');
  });

  it('treats a path with an extension as the file it names', () => {
    expect(resolve('src/db/connection.ts')).toBe('../db/connection.js');
  });

  it('keeps a path that names a file rather than a directory', () => {
    expect(resolve('src/validators/zod/index.ts')).toBe('../validators/zod/index.js');
  });

  it('handles a path already written with a .js extension', () => {
    // Must not become `index.js.js`.
    expect(resolve('src/validators/zod/index.js')).toBe('../validators/zod/index.js');
  });
});

describe('an already relative path', () => {
  it('is left alone apart from its extension, so older configs keep working', () => {
    expect(resolve('../validators/zod/index.js')).toBe('../validators/zod/index.js');
  });

  it('gains /index and an extension when it names a directory', () => {
    expect(resolve('../validators/zod')).toBe('../validators/zod/index.js');
  });

  it('keeps its own spelling rather than being recomputed from outDir', () => {
    expect(resolve('./local/schemas.ts')).toBe('./local/schemas.js');
  });
});

describe('a package specifier', () => {
  it.each(['zod', '@acme/schemas', '@acme/schemas/sub', 'node:path'])(
    'leaves %s exactly as written',
    (spec) => {
      expect(resolve(spec)).toBe(spec);
    }
  );
});

describe('importExtension', () => {
  it('omits the extension when asked', () => {
    expect(resolve('src/validators/zod', 'none')).toBe('../validators/zod/index');
  });

  it('keeps .ts when asked', () => {
    expect(resolve('src/validators/zod', 'ts')).toBe('../validators/zod/index.ts');
  });

  it('defaults to .js, the only form resolving under every moduleResolution', () => {
    expect(resolve('src/validators/zod')).toBe('../validators/zod/index.js');
  });
});

describe('an absolute path', () => {
  it('is made relative to the importing directory', () => {
    expect(resolve(path.resolve('/project/src/validators/zod'))).toBe(
      '../validators/zod/index.js'
    );
  });
});

describe('file or directory, decided from disk', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const osmod = require('node:os') as typeof import('node:os');

  it('treats a path naming an existing .ts module as the file it is', async () => {
    // `src/db/connection` names connection.ts. Nothing sits at the bare path, so without
    // looking for the sibling source file this was mistaken for a directory and emitted as
    // `../db/connection/index.js`, which resolves to nothing.
    const root = fs.mkdtempSync(path.join(osmod.tmpdir(), 'drzl-ci-'));
    fs.mkdirSync(path.join(root, 'src', 'db'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'db', 'connection.ts'), 'export const db = 1;');
    fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });

    expect(
      resolveConfiguredImport('src/db/connection', path.join(root, 'src', 'api'), root)
    ).toBe('../db/connection.js');
  });

  it('treats a path naming an existing directory as a barrel', () => {
    const root = fs.mkdtempSync(path.join(osmod.tmpdir(), 'drzl-ci-'));
    fs.mkdirSync(path.join(root, 'src', 'db', 'schemas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'db', 'schemas', 'index.ts'), 'export const x = 1;');
    fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });

    expect(resolveConfiguredImport('src/db/schemas', path.join(root, 'src', 'api'), root)).toBe(
      '../db/schemas/index.js'
    );
  });
});
