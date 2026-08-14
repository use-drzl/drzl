/**
 * The fingerprint that lets `watch` skip a rebuild which would change nothing.
 *
 * Two directions matter and they fail differently. A false *positive* (reporting a change that is
 * not there) costs a rebuild nobody needed, which is the state before this existed and is merely
 * slow. A false *negative* (reporting no change when there is one) means a save that silently does
 * not regenerate, and the user watches their editor and their output disagree with no way to tell
 * why. Every test below that adds a field is guarding the second one.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import {
  analysisFingerprint,
  configFingerprint,
  rebuildSignature,
  sameAsLast,
} from '../src/rebuild-fingerprint.js';

function col(name: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(name: string, columns: Column[] = [col('id')]): Table {
  return { name, tsName: name, unique: [], indexes: [], columns } as Table;
}

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    dialect: 'postgres',
    tables: [table('users')],
    enums: [],
    relations: [],
    issues: [],
    ...over,
  } as Analysis;
}

describe('what counts as the same', () => {
  it('is stable across two analyses of the same schema', () => {
    expect(analysisFingerprint(analysis())).toBe(analysisFingerprint(analysis()));
  });

  /**
   * Key order must not matter.
   *
   * `JSON.stringify` preserves insertion order, and the analyzer builds its objects by walking
   * drizzle's structures, so two runs over an unchanged schema are not guaranteed to agree on it.
   * Hashing the raw output would report a change on a save that changed nothing, which is the
   * false positive that would make this feature do nothing at all.
   */
  it('does not depend on the order of object keys', () => {
    const a = analysis({ tables: [{ name: 'users', tsName: 'users', unique: [], indexes: [], columns: [] } as Table] });
    const b = analysis({ tables: [{ columns: [], indexes: [], unique: [], tsName: 'users', name: 'users' } as Table] });
    expect(analysisFingerprint(a)).toBe(analysisFingerprint(b));
  });

  /**
   * A warning changes what `doctor` prints and never changes an emitted file, so folding `issues`
   * in would make a rebuild that produced identical output look different.
   */
  it('ignores issues, which never reach an emitted file', () => {
    const quiet = analysis();
    const noisy = analysis({
      issues: [{ code: 'DRZL_ANL_UNKNOWN_COLUMN', level: 'warn', message: 'x' }] as never,
    });
    expect(analysisFingerprint(quiet)).toBe(analysisFingerprint(noisy));
  });
});

describe('what counts as different, which is the half that must not miss', () => {
  const base = analysisFingerprint(analysis());

  it('notices a new table', () => {
    expect(analysisFingerprint(analysis({ tables: [table('users'), table('posts')] }))).not.toBe(base);
  });

  it('notices a removed table', () => {
    expect(analysisFingerprint(analysis({ tables: [] }))).not.toBe(base);
  });

  it('notices a renamed table', () => {
    expect(analysisFingerprint(analysis({ tables: [table('people')] }))).not.toBe(base);
  });

  it('notices a new column', () => {
    const next = analysis({ tables: [table('users', [col('id'), col('email')])] });
    expect(analysisFingerprint(next)).not.toBe(base);
  });

  it('notices a column changing type', () => {
    const next = analysis({ tables: [table('users', [col('id', { tsType: 'number' })])] });
    expect(analysisFingerprint(next)).not.toBe(base);
  });

  it('notices a column becoming nullable', () => {
    const next = analysis({ tables: [table('users', [col('id', { nullable: true })])] });
    expect(analysisFingerprint(next)).not.toBe(base);
  });

  it('notices a changed dialect', () => {
    expect(analysisFingerprint(analysis({ dialect: 'mysql' as never }))).not.toBe(base);
  });

  it('notices a changed enum', () => {
    const next = analysis({ enums: [{ name: 'mood', values: ['ok'] }] as never });
    expect(analysisFingerprint(next)).not.toBe(base);
  });

  it('notices a changed relation', () => {
    const next = analysis({ relations: [{ from: 'users', to: 'posts' }] as never });
    expect(analysisFingerprint(next)).not.toBe(base);
  });

  /**
   * A CHECK constraint is the one most likely to be forgotten, because it lives on the table rather
   * than on a column and half the generators fold it into a range rather than emitting it whole.
   */
  it('notices a changed CHECK constraint', () => {
    const withCheck = analysis({
      tables: [{ ...table('users'), checks: [{ name: 'c', expression: 'id > 0' }] } as Table],
    });
    expect(analysisFingerprint(withCheck)).not.toBe(base);
  });
});

describe('the config, which changes output with the schema untouched', () => {
  it('is part of the signature', () => {
    const a = rebuildSignature(analysis(), [{ kind: 'zod' }]);
    const b = rebuildSignature(analysis(), [{ kind: 'zod' }, { kind: 'valibot' }]);
    expect(sameAsLast(a, b)).toBe(false);
  });

  it('is the same when the generators are', () => {
    const a = rebuildSignature(analysis(), [{ kind: 'zod', path: 'x' }]);
    const b = rebuildSignature(analysis(), [{ kind: 'zod', path: 'x' }]);
    expect(sameAsLast(a, b)).toBe(true);
  });

  it('notices an option changing on a generator that is otherwise the same', () => {
    const a = configFingerprint([{ kind: 'zod', naming: { schemaSuffix: 'Schema' } }]);
    const b = configFingerprint([{ kind: 'zod', naming: { schemaSuffix: 'Model' } }]);
    expect(a).not.toBe(b);
  });
});

describe('the first build', () => {
  /**
   * Always runs.
   *
   * Skipping it would leave a watcher that started, printed its watch list and wrote nothing, which
   * this command has shipped before for a different reason and is the worst failure it has.
   */
  it('is never skipped, because there is nothing to compare against', () => {
    expect(sameAsLast(undefined, rebuildSignature(analysis(), []))).toBe(false);
  });
});
