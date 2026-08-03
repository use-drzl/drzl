/**
 * The routers this generator writes are still formatted, after losing their private formatter.
 *
 * This package used to carry its own copy of `formatCode`, with its own `await import('prettier')`
 * that bundled 11 MB of prettier into `dist`. Deleting the copy in favour of the one exported by
 * @drzl/validation-core is invisible to every other test here: unformatted output is still valid
 * TypeScript, still parses, still typechecks, and none of the sibling specs assert on whitespace.
 * A wired-up call that silently stopped formatting would therefore look exactly like success.
 *
 * So this compares the emitted file against what prettier makes of the same file, rather than
 * against a fixed string, which keeps it honest without pinning prettier's output style.
 */
import { describe, it, expect } from 'vitest';
import { ORPCGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const analysis: Analysis = {
  dialect: 'sqlite',
  tables: [
    {
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
      ],
      unique: [],
      indexes: [],
      primaryKey: { columns: ['id'] },
    } as never,
  ],
  enums: [],
  relations: [],
  issues: [],
};

/** Emit into a temp directory, so no .prettierrc.json above it can affect the comparison. */
async function emit(format?: { enabled?: boolean }) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-fmt-'));
  await new ORPCGenerator(analysis).generate({ outputDir, format } as never);
  return {
    router: await fs.readFile(path.join(outputDir, 'users.ts'), 'utf8'),
    barrel: await fs.readFile(path.join(outputDir, 'index.ts'), 'utf8'),
    at: path.join(outputDir, 'users.ts'),
  };
}

describe('emitted oRPC output', () => {
  it('is formatted by prettier, not merely written out', async () => {
    const formatted = await emit();
    const raw = await emit({ enabled: false });
    const prettier = await import('prettier');
    expect(formatted.router).toBe(
      await prettier.format(raw.router, { parser: 'typescript', filepath: raw.at })
    );
    // The two agreeing would also be satisfied by output that needs no formatting, so the raw
    // form has to be different for the comparison above to have proved anything.
    expect(formatted.router).not.toBe(raw.router);
  });

  it('formats the router barrel too', async () => {
    const { barrel } = await emit();
    const { barrel: raw } = await emit({ enabled: false });
    expect(barrel).not.toBe(raw);
  });

  it('still honours format.enabled false', async () => {
    // The one setting a shared implementation could plausibly drop, and the only way a user has
    // of keeping DRZL's hands off their whitespace.
    const { router } = await emit({ enabled: false });
    expect(router).toMatch(/from '/);
  });
});
