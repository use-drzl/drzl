/**
 * The generated router has to compile in the consumer's project.
 *
 * It did not. `create` and `update` declared `.output(SelectSchema)` and then returned the
 * input, which is the *insert* shape: generated and defaulted columns are optional there and
 * required in select, so `tsc --strict` rejected every generated router. Three errors on a
 * two-table schema, present with every built-in template, and shipped for as long as the
 * package has existed because nothing ever compiled the output.
 *
 * A stub cannot return a created row, because it has not created one: the row carries generated
 * columns the input does not have. Returning the input was not a placeholder, it was the wrong
 * answer typed wrongly. These stubs throw instead, which satisfies the declared contract, since
 * a body that only throws has type `never`, and says plainly that the work is not done.
 *
 * Full compilation of the emitted tree is verified by scripts/verify-packed.sh against the real
 * packed artefacts, where @orpc/server is installed. These cases pin the shape that made it fail.
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
        // Generated, so it is optional on insert and required on select. This asymmetry is
        // precisely what the old stub violated.
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
    },
  ] as any,
  enums: [],
  relations: [],
  issues: [],
};

async function render(opts: Record<string, unknown> = {}) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-out-'));
  await new ORPCGenerator(analysis).generate({ outputDir: outDir, ...opts } as any);
  return fs.readFile(path.join(outDir, 'users.ts'), 'utf8');
}

/** The body of a named procedure, from its declaration to the closing `});`. */
function bodyOf(source: string, varName: string): string {
  const start = source.indexOf(`const ${varName} =`);
  expect(start, `no declaration of ${varName} in:\n${source}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('});', start);
  return source.slice(start, end + 3);
}

describe.each([
  ['default template', {}],
  ['standard template', { template: 'standard' }],
])('%s', (_label, opts) => {
  it('does not return the input from create, which is the wrong shape', async () => {
    const body = bodyOf(await render(opts), 'createUsers');
    expect(body).not.toMatch(/return\s+_input\s*;/);
  });

  it('does not return the input from update either', async () => {
    const body = bodyOf(await render(opts), 'updateUsers');
    expect(body).not.toMatch(/return\s+_input\.data\s*;/);
  });

  it('keeps the output contract on create rather than dropping it to compile', async () => {
    const body = bodyOf(await render(opts), 'createUsers');
    expect(body).toContain('.output(SelectusersSchema)');
  });

  it('makes an unimplemented stub fail loudly instead of returning bad data', async () => {
    const source = await render(opts);
    for (const v of ['createUsers', 'updateUsers']) {
      expect(bodyOf(source, v), v).toMatch(/throw new Error\(/);
    }
  });

  it('leaves the procedures that were already correct alone', async () => {
    const source = await render(opts);
    expect(bodyOf(source, 'listUsers')).toContain('return []');
    expect(bodyOf(source, 'getUsers')).toContain('return null');
    expect(bodyOf(source, 'deleteUsers')).toContain('return true');
  });

  it('still parses', async () => {
    const source = await render(opts);
    const ts = await import('typescript');
    const sf = ts.createSourceFile('users.ts', source, ts.ScriptTarget.ES2022, true);
    expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? []).toHaveLength(
      0
    );
  });
});

describe('templates that implement their handlers', () => {
  it('is left untouched, since its body already satisfies the output', async () => {
    // @drzl/template-orpc-service delegates to a service layer and returns its result, which is
    // the select shape. Rewriting that body would destroy a real implementation, so the fix
    // lives in the stub templates rather than in the generator.
    const source = await render({ template: '@drzl/template-orpc-service' });
    expect(bodyOf(source, 'createUsers')).toContain('UserService.create');
    expect(bodyOf(source, 'createUsers')).not.toMatch(/throw new Error\(/);
  });
});
