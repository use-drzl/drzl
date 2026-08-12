/**
 * What the forms generator emits.
 *
 * The field metadata is the half worth testing hardest, because it is the half that can be wrong
 * while looking right: an input carrying `min="-2147483648"` for a column the database restricts to
 * 18 renders fine, submits fine, and is a lie. `fieldFacts` in `@drzl/validation-core` performs the
 * fold and has its own suite; what is asserted here is that this generator emits what that returned
 * rather than reading the column itself.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { FormsGenerator } from '../src/index.js';

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

const users = {
  name: 'users',
  tsName: 'users',
  dialect: 'postgres',
  unique: [],
  indexes: [],
  columns: [
    col('id', 'number', { min: '-2147483648', max: '2147483647', integer: true, hasDefault: true }),
    col('handle', 'string', { maxLength: 40 }),
    col('age', 'number', { min: '-2147483648', max: '2147483647', integer: true }),
    col('tier', 'string', { enumValues: ['free', 'pro'] }),
    col('active', 'boolean', { hasDefault: true, defaultValue: true }),
  ],
  checks: [
    { name: 'adult', expression: 'age >= 18' },
    { name: 'handle_len', expression: 'length(handle) <= 20' },
  ],
} as Table;

const analysis: Analysis = {
  dialect: 'postgres',
  tables: [users],
  enums: [],
  relations: [],
  issues: [],
} as Analysis;

async function emit(
  over: Record<string, unknown> = {},
  a: Analysis = analysis
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await new FormsGenerator(a).generate({
    outputDir: '/virtual/out',
    validation: { useShared: true, importPath: '../zod' },
    format: { enabled: false },
    fileSink: {
      mkdir: async () => undefined,
      writeFile: async (p: string, content: string) => {
        files[p.split('/').pop()!] = content;
      },
    } as never,
    ...over,
  } as never);
  return files;
}

describe('the field metadata', () => {
  /** MUST FIRE. Reading the column instead of the fold puts a bound on the input that is not one. */
  it('carries the CHECK-narrowed bound, not the column type range', async () => {
    const f = (await emit())['users.form.ts'];
    // Scoped to `age`, which is the column a CHECK narrows. `id` carries no check and keeps its
    // int32 range legitimately, so an unscoped match would pass on the wrong field.
    const age = f.slice(f.indexOf('"age":'), f.indexOf('"tier":'));
    expect(age, 'the fold did not reach the emitted metadata').toContain('min: "18"');
    expect(age, 'the int32 floor leaked into the input for a checked column').not.toContain('-2147483648');
  });

  it('carries the tighter of a declared width and a length CHECK', async () => {
    const f = (await emit())['users.form.ts'];
    expect(f).toContain('maxLength: 20');
    expect(f).not.toContain('maxLength: 40');
  });

  it('names the control each column asks for', async () => {
    const f = (await emit())['users.form.ts'];
    expect(f).toContain('control: "select"');
    expect(f).toContain('control: "checkbox"');
    expect(f).toContain('control: "number"');
    expect(f).toContain('options: [');
  });

  it('says which fields a form has to supply', async () => {
    const f = (await emit())['users.form.ts'];
    // `id` and `active` carry defaults, so a form need not supply either.
    expect(f).toMatch(/"id": \{[^}]*required: false/s);
    expect(f).toMatch(/"handle": \{[^}]*required: true/s);
  });

  it('is emitted `as const`, so a consumer reads literal types rather than string', async () => {
    expect((await emit())['users.form.ts']).toContain('} as const;');
  });
});

describe('the resolver', () => {
  it('uses the shared Standard Schema resolver for zod', async () => {
    const f = (await emit())['users.form.ts'];
    expect(f).toContain('from "@hookform/resolvers/standard-schema"');
    expect(f).toContain('usersInsertResolver = standardSchemaResolver(InsertusersSchema)');
    expect(f).toContain('usersUpdateResolver = standardSchemaResolver(UpdateusersSchema)');
  });

  it.each([
    ['typebox', '@hookform/resolvers/typebox', 'typeboxResolver'],
    ['effect', '@hookform/resolvers/effect-ts', 'effectTsResolver'],
  ])('uses the dedicated resolver for %s, which has no ~standard', async (lib, spec, fn) => {
    const f = (
      await emit({ validation: { useShared: true, importPath: '../v', library: lib } })
    )['users.form.ts'];
    expect(f).toContain(`from "${spec}"`);
    expect(f).toContain(`${fn}(`);
  });

  it('emits no select resolver unless asked, since a select schema describes a row coming out', async () => {
    const f = (await emit())['users.form.ts'];
    expect(f).not.toContain('usersSelectResolver');
    const withSelect = (await emit({ modes: ['select'] }))['users.form.ts'];
    expect(withSelect).toContain('usersSelectResolver');
  });
});

describe('the TanStack target', () => {
  it('passes the schema straight in, with no resolver', async () => {
    const f = (await emit({ target: 'tanstack-form' }))['users.form.ts'];
    expect(f).toContain('usersInsertFormOptions');
    expect(f).toContain('validators: { onChange: InsertusersSchema }');
    expect(f, 'TanStack Form needs no resolver').not.toContain('@hookform/resolvers');
  });

  it('emits both shapes on `both`', async () => {
    const f = (await emit({ target: 'both' }))['users.form.ts'];
    expect(f).toContain('usersInsertResolver');
    expect(f).toContain('usersInsertFormOptions');
  });

  /**
   * Measured: TypeBox exposes no `~standard`, so TanStack Form has nothing to validate with. An
   * options object naming it would be silently ignored, which is the failure this refuses.
   */
  it('refuses a library TanStack Form cannot read', async () => {
    await expect(
      emit({ target: 'tanstack-form', validation: { useShared: true, importPath: '../v', library: 'typebox' } })
    ).rejects.toThrow(/Standard Schema/);
  });
});

describe('what it refuses, and what it skips', () => {
  it('refuses without validation.importPath', async () => {
    await expect(emit({ validation: { useShared: true } })).rejects.toThrow(/importPath/);
  });

  it('emits only a select module for a read-only relation', async () => {
    const view = { ...users, tsName: 'reports', name: 'reports', readOnly: true } as Table;
    const files = await emit({ modes: ['insert', 'update', 'select'] }, {
      ...analysis,
      tables: [view],
    } as Analysis);
    const f = files['reports.form.ts'];
    expect(f).toContain('reportsSelectResolver');
    expect(f).not.toContain('reportsInsertResolver');
  });

  it('writes a barrel over the modules it wrote', async () => {
    const files = await emit();
    expect(files['index.ts']).toContain('export * from "./users.form.js";');
  });
});
