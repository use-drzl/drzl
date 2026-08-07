/**
 * The output is formatted, and stays valid when it is not.
 *
 * `formatCode` is shared with every other DRZL generator and prettier is an *optional* peer, so
 * "no formatter installed" is a supported state rather than a broken install. A wired-up call
 * that silently stopped formatting would look exactly like success to every other spec here,
 * because unformatted output still parses, still typechecks and is asserted on nowhere else.
 *
 * Compared against what prettier makes of the same file rather than against a fixed string, so
 * this stays honest without pinning prettier's style.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { analysis, users } from './fixtures';

async function emit(format?: { enabled?: boolean }) {
  // A temp directory, so no .prettierrc above the workspace can affect the comparison.
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-fmt-'));
  await new TRPCGenerator(analysis([users])).generate({ outputDir, format } as never);
  const read = (n: string) => fs.readFile(path.join(outputDir, n), 'utf8');
  return {
    router: await read('users.ts'),
    barrel: await read('index.ts'),
    base: await read('trpc.ts'),
    at: path.join(outputDir, 'users.ts'),
  };
}

describe('emitted tRPC output', () => {
  it('is formatted by prettier, not merely written out', async () => {
    const formatted = await emit();
    const raw = await emit({ enabled: false });
    const prettier = await import('prettier');
    expect(formatted.router).toBe(
      await prettier.format(raw.router, { parser: 'typescript', filepath: raw.at })
    );
    // Agreement would also be satisfied by output that needs no formatting, so the raw form has
    // to differ for the comparison above to have proved anything.
    expect(formatted.router).not.toBe(raw.router);
  });

  it('formats the base module and the app router too', async () => {
    const formatted = await emit();
    const raw = await emit({ enabled: false });
    const prettier = await import('prettier');
    expect(formatted.base).not.toBe(raw.base);
    expect(formatted.barrel).not.toBe(raw.barrel);
    expect(formatted.barrel).toBe(
      await prettier.format(raw.barrel, { parser: 'typescript', filepath: 'index.ts' })
    );
  });

  it('honours format.enabled false', async () => {
    const { router } = await emit({ enabled: false });
    expect(router).toMatch(/from '/);
  });

  it('emits parseable TypeScript with the formatter off', async () => {
    // The formatter is the last step, so a syntax error it would have thrown on is a syntax error
    // that reaches the user's disk when they have no prettier installed.
    const ts = await import('typescript');
    const raw = await emit({ enabled: false });
    for (const [name, source] of Object.entries({
      router: raw.router,
      barrel: raw.barrel,
      base: raw.base,
    })) {
      const sf = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.ES2022, true);
      expect(
        (sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? [],
        name
      ).toHaveLength(0);
    }
  });
});
