/**
 * `--only` and the `--pipeline` spelling it replaces, read apart from any command.
 *
 * The defect this file was written against is a silent one, which is why it is tested here as well
 * as end to end: `--pipeline` listed seven of the fourteen kinds, and the other seven matched no
 * branch at all, so `drzl watch --pipeline generate-zod` started, printed its watch list, and
 * regenerated nothing for as long as it ran. Nothing was wrong with the config, nothing was
 * printed, and the flag was in the documented list of what the option accepted for exactly one of
 * the two commands that can run a generator.
 *
 * The unit tests are the ones that can enumerate all fourteen kinds cheaply; the end-to-end spec
 * proves the wiring on two of them.
 */
import { describe, expect, it } from 'vitest';
import { GENERATOR_KINDS } from '../src/config.js';
import {
  emptySelectionMessage,
  KindSelectionError,
  parseOnly,
  resolveWatchSelection,
  selectGenerators,
} from '../src/kind-selection.js';

describe('--only', () => {
  it('is absent when the flag is not passed, which is every generator in the config', () => {
    expect(parseOnly(undefined)).toBeUndefined();
  });

  it('accepts every kind the config schema accepts', () => {
    // The whole point of reading the enum rather than a list of its own: a kind added to the
    // config is accepted here on the same commit, with nothing to remember.
    for (const kind of GENERATOR_KINDS) {
      expect([...parseOnly(kind)!]).toEqual([kind]);
    }
  });

  it('takes a comma-separated list, and tolerates the spaces a shell leaves in', () => {
    expect([...parseOnly('zod, trpc ,json-schema')!].sort()).toEqual([
      'json-schema',
      'trpc',
      'zod',
    ]);
  });

  it('refuses a kind that does not exist by name, rather than matching nothing', () => {
    let thrown: unknown;
    try {
      parseOnly('zodd');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KindSelectionError);
    expect((thrown as Error).message).toContain('zodd');
    // The list, because a typo is usually one letter away from something real.
    expect((thrown as KindSelectionError).hint).toContain('valibot');
  });

  it('names the bare kind when given the --pipeline spelling', () => {
    // The two vocabularies are the reason this flag exists, so the one mistake everybody makes
    // gets the answer rather than a list of fourteen alternatives.
    let thrown: KindSelectionError | undefined;
    try {
      parseOnly('generate-orpc');
    } catch (e) {
      thrown = e as KindSelectionError;
    }
    expect(thrown?.hint).toBe('Write it the way the config does: --only orpc.');
  });

  it('refuses an empty value rather than selecting nothing', () => {
    expect(() => parseOnly('')).toThrow(KindSelectionError);
    expect(() => parseOnly(',,')).toThrow(KindSelectionError);
  });
});

describe('--pipeline, now an alias', () => {
  it('defaults to every generator', () => {
    expect(resolveWatchSelection({})).toEqual({ analyzeOnly: false, kinds: undefined });
    expect(resolveWatchSelection({ pipeline: 'all' })).toEqual({
      analyzeOnly: false,
      kinds: undefined,
    });
  });

  it('keeps meaning what it meant for analyze', () => {
    expect(resolveWatchSelection({ pipeline: 'analyze' })).toEqual({ analyzeOnly: true });
  });

  it('reaches all fourteen kinds, not the seven it used to list', () => {
    // Seven of these matched no branch before this change: service, zod, valibot, arktype,
    // typebox, effect and json-schema. Each one started a watcher that did nothing.
    for (const kind of GENERATOR_KINDS) {
      const selection = resolveWatchSelection({ pipeline: `generate-${kind}` });
      expect([...selection.kinds!], kind).toEqual([kind]);
    }
  });

  it('refuses a pipeline name that is not one, where it used to match nothing in silence', () => {
    let thrown: unknown;
    try {
      resolveWatchSelection({ pipeline: 'generate-nonsense' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KindSelectionError);
    expect((thrown as Error).message).toContain('generate-nonsense');
  });

  it('refuses to guess when both flags narrow the run', () => {
    expect(() => resolveWatchSelection({ pipeline: 'generate-zod', only: 'trpc' })).toThrow(
      KindSelectionError
    );
    expect(() => resolveWatchSelection({ pipeline: 'analyze', only: 'trpc' })).toThrow(
      KindSelectionError
    );
  });
});

describe('applying a selection to a config', () => {
  const generators = [
    { kind: 'orpc' as const },
    { kind: 'zod' as const, path: 'a' },
    { kind: 'zod' as const, path: 'b' },
  ];

  it('keeps every entry of a selected kind, in the order the config wrote them', () => {
    // Two entries of one kind pointed at different paths is a real config, and a selection that
    // kept only the first would silently stop writing the second.
    expect(selectGenerators(generators, new Set(['zod']))).toEqual([
      { kind: 'zod', path: 'a' },
      { kind: 'zod', path: 'b' },
    ]);
  });

  it('keeps everything when nothing was selected', () => {
    expect(selectGenerators(generators, undefined)).toEqual(generators);
  });

  it('says so when the selection matched nothing, naming both halves', () => {
    const message = emptySelectionMessage(new Set(['trpc']), generators);
    expect(message).toContain('trpc');
    expect(message).toContain('orpc, zod');
  });

  it('says nothing when the selection matched something', () => {
    expect(emptySelectionMessage(new Set(['orpc']), generators)).toBeUndefined();
    expect(emptySelectionMessage(undefined, generators)).toBeUndefined();
  });
});
