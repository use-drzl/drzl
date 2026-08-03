/**
 * The services this generator writes are still formatted, after losing their private formatter.
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
import { ServiceGenerator } from '../src';
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
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-svc-fmt-'));
  const files = await new ServiceGenerator(analysis).generate({
    outDir,
    dataAccess: 'stub',
    format,
  });
  const service = files.find((f) => /Service\.ts$/.test(f))!;
  const types = files.find((f) => /types\/users\.ts$/.test(f))!;
  return {
    service: await fs.readFile(service, 'utf8'),
    types: await fs.readFile(types, 'utf8'),
    at: service,
  };
}

describe('emitted service output', () => {
  it('is formatted by prettier, not merely written out', async () => {
    const formatted = await emit();
    const raw = await emit({ enabled: false });
    const prettier = await import('prettier');
    expect(formatted.service).toBe(
      await prettier.format(raw.service, { parser: 'typescript', filepath: raw.at })
    );
    // The two agreeing would also be satisfied by output that needs no formatting, so the raw
    // form has to be different for the comparison above to have proved anything.
    expect(formatted.service).not.toBe(raw.service);
  });

  it('formats the types file too, which is written by the same call', async () => {
    const { types } = await emit();
    const { types: raw } = await emit({ enabled: false });
    expect(types).not.toBe(raw);
  });

  it('still honours format.enabled false', async () => {
    // The one setting a shared implementation could plausibly drop, and the only way a user has
    // of keeping DRZL's hands off their whitespace.
    const { service } = await emit({ enabled: false });
    expect(service).toContain('export class UserService {');
  });
});
