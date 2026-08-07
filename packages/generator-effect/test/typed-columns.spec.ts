/**
 * `typedJson` and `typedColumns` in the Effect generator.
 *
 * `.$type<T>()` is a compile-time cast, so nothing about it survives to runtime and every
 * runtime-derived validator is blind to it. The repair is the same one every generator here makes:
 * reference what Drizzle already inferred, `(typeof users.$inferSelect)['prefs']`, and let
 * TypeScript resolve it at the point of use.
 *
 * Effect has no `Type.Unsafe` to hang that on. What it has is a schema type, so the reference goes
 * on as `as unknown as Schema.Schema<T>`: a compile-time-only claim, which is exactly the register
 * the fact lives in. The runtime schema underneath is untouched, so every check it carried still
 * runs, and that is what the case below measures rather than assumes.
 */
import { describe, it, expect } from 'vitest';
import { accepts, analysisOf, col, emit, emitText, table } from './fixtures';

const oneCol = (c: ReturnType<typeof col>) => analysisOf([table('t', [c])]);
const schemaPath = '/tmp/does-not-need-to-exist/db/schema.ts';

describe('off by default', () => {
  it('adds nothing when neither option is set', async () => {
    const text = await emitText(oneCol(col('role', { format: 'uuid' })), { schemaPath });
    expect(text).not.toContain('as unknown as');
    expect(text).not.toContain('import type');
  });

  it('is not turned on by typedJson, which covers only the untyped columns', async () => {
    const text = await emitText(oneCol(col('role', { format: 'uuid' })), {
      schemaPath,
      typedJson: true,
    });
    expect(text).not.toContain('as unknown as');
  });
});

describe('typedJson', () => {
  it('replaces a json column with the type Drizzle inferred', async () => {
    const text = await emitText(
      oneCol(col('doc', { tsType: 'any', shape: { kind: 'json' } as never })),
      { schemaPath, typedJson: true }
    );
    // Whitespace collapsed, because prettier wraps a long field across lines.
    expect(text.replace(/\s+/g, '')).toContain(
      "Schema.Unknown as unknown as Schema.Schema<(typeof t.$inferSelect)['doc']>".replace(
        /\s+/g,
        ''
      )
    );
    expect(text).toMatch(/import type \{ t \} from/);
  });

  it('drops the recursive JSON preamble it no longer needs', async () => {
    const text = await emitText(
      oneCol(col('doc', { tsType: 'any', shape: { kind: 'json' } as never })),
      { schemaPath, typedJson: true }
    );
    expect(text).not.toContain('DrzlJsonValue');
  });

  it('says so and carries on when the schema path is unknown', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      const text = await emitText(
        oneCol(col('doc', { tsType: 'any', shape: { kind: 'json' } as never })),
        { typedJson: true }
      );
      expect(text).toContain('DrzlJsonValue');
      expect(warnings.join('\n')).toContain('typedJson');
    } finally {
      console.warn = original;
    }
  });
});

describe('typedColumns', () => {
  it('narrows a column that already has a runtime type', async () => {
    const text = await emitText(oneCol(col('role', { format: 'uuid' })), {
      schemaPath,
      typedColumns: true,
    });
    expect(text.replace(/\s+/g, '')).toMatch(
      /Schema\.UUIDasunknownasSchema\.Schema<\(typeoft\.\$inferSelect\)\['role'\]>/
    );
  });

  it('keeps every runtime check the narrowed schema carried', async () => {
    // This is the whole point of a cast over a substitution: the checks still run.
    const m = await emit(oneCol(col('role', { format: 'uuid' })), {
      schemaPath,
      typedColumns: true,
    });
    expect(accepts(m.SelecttSchema, { role: '00000000-0000-0000-0000-000000000000' })).toBe(true);
    expect(accepts(m.SelecttSchema, { role: 'nope' })).toBe(false);
    expect(accepts(m.SelecttSchema, { role: 5 })).toBe(false);
  });

  it('keeps a character cap through the cast', async () => {
    const m = await emit(oneCol(col('n', { maxLength: 3 })), { schemaPath, typedColumns: true });
    expect(accepts(m.SelecttSchema, { n: '\u{1F44D}'.repeat(3) })).toBe(true);
    expect(accepts(m.SelecttSchema, { n: 'abcd' })).toBe(false);
  });

  it('implies typedJson, since both need the schema imported back', async () => {
    const text = await emitText(
      oneCol(col('doc', { tsType: 'any', shape: { kind: 'json' } as never })),
      { schemaPath, typedColumns: true }
    );
    expect(text).toMatch(/import type \{ t \} from/);
  });

  it('names the insert type on the insert schema and the select type on the select one', async () => {
    const text = await emitText(oneCol(col('n')), { schemaPath, typedColumns: true });
    expect(text).toContain('$inferInsert');
    expect(text).toContain('$inferSelect');
  });
});
