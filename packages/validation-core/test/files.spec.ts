import { describe, expect, it } from 'vitest';
import { moduleFileName, moduleSpecifier } from '../src';

describe('@drzl/validation-core file names', () => {
  it('reproduces the pre-fix barrel for every default suffix', () => {
    expect(moduleFileName('users', '.zod.ts')).toBe('users.zod.ts');
    expect(moduleSpecifier('users', '.zod.ts')).toBe('./users.zod');
    expect(moduleSpecifier('users', '.valibot.ts')).toBe('./users.valibot');
    expect(moduleSpecifier('users', '.arktype.ts')).toBe('./users.arktype');
  });

  it('follows a custom suffix instead of the default', () => {
    expect(moduleFileName('users', '.schema.ts')).toBe('users.schema.ts');
    expect(moduleSpecifier('users', '.schema.ts')).toBe('./users.schema');
  });

  it('handles a suffix with no leading dot', () => {
    expect(moduleFileName('users', 'Schema.ts')).toBe('usersSchema.ts');
    expect(moduleSpecifier('users', 'Schema.ts')).toBe('./usersSchema');
    expect(moduleSpecifier('users', '-validators.ts')).toBe('./users-validators');
  });

  it('handles a suffix that is only an extension', () => {
    expect(moduleFileName('users', '.ts')).toBe('users.ts');
    expect(moduleSpecifier('users', '.ts')).toBe('./users');
    expect(moduleSpecifier('users', '.tsx')).toBe('./users');
  });

  it('gives .mts and .cts the extension an import has to spell', () => {
    // Verified against tsc: an extensionless specifier never reaches a .mts or .cts file
    // under bundler, node10 or node16, but .mjs and .cjs reach them under all three.
    expect(moduleFileName('users', '.zod.mts')).toBe('users.zod.mts');
    expect(moduleSpecifier('users', '.zod.mts')).toBe('./users.zod.mjs');
    expect(moduleSpecifier('users', '.zod.cts')).toBe('./users.zod.cjs');
    expect(moduleSpecifier('users', '.mts')).toBe('./users.mjs');
    expect(moduleSpecifier('users', '.cts')).toBe('./users.cjs');
  });

  it('leaves a name alone when the suffix ends in no TypeScript extension', () => {
    // Nothing can import such a file, but the barrel still has to name what was written
    // rather than invent a neighbour that does not exist.
    expect(moduleSpecifier('users', '.zod')).toBe('./users.zod');
    expect(moduleSpecifier('users', '')).toBe('./users');
    expect(moduleSpecifier('users', '.d.ts')).toBe('./users.d');
  });

  it('does not mistake a table name ending in ts for an extension', () => {
    expect(moduleSpecifier('accounts', '.zod.ts')).toBe('./accounts.zod');
    expect(moduleSpecifier('receipts', '')).toBe('./receipts');
  });
});
