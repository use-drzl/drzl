/**
 * The facts about `effect` itself that this generator is built on.
 *
 * Every one of these was measured before a line of the generator was written, and each is an
 * assumption the emitted code would be silently wrong without. They live in a test rather than in
 * a comment because a comment asserting a mechanism is a claim nobody re-runs, and `effect` is a
 * fast-moving package: the plan item that produced this generator was parked for a release cycle
 * on the belief that Schema still lived in a separate package, which by then it did not.
 *
 * The two version facts worth stating outright:
 *
 *   - Schema is part of `effect` core and is imported from `effect/Schema`. The standalone
 *     `@effect/schema` package stopped at 0.75.5 and predates the move, so it is not a target.
 *   - `effect` 4.x exists only as a beta (4.0.0-beta.105 at the time of writing). This generator
 *     targets 3.x, and `peerDependencies` says `>=3.13.0` because that is where
 *     `Schema.standardSchemaV1` first appears; 3.12.0 does not have it.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as Either from 'effect/Either';
import * as JSONSchema from 'effect/JSONSchema';
import * as Schema from 'effect/Schema';

const require_ = createRequire(import.meta.url);
const installed: string = require_('effect/package.json').version;

const accepts = (s: unknown, v: unknown) =>
  Either.isRight(Schema.decodeUnknownEither(s as Schema.Schema<unknown>)(v));

describe('the effect package under test', () => {
  it('is a 3.x release, not the 4.0 beta and not @effect/schema', () => {
    expect(installed.startsWith('3.')).toBe(true);
  });

  it('is at least 3.13.0, which is where standardSchemaV1 appears', () => {
    const [maj, min] = installed.split('.').map(Number);
    expect(maj).toBe(3);
    expect(min).toBeGreaterThanOrEqual(13);
  });

  it('carries every constructor the generator emits', () => {
    const used = [
      'String',
      'Number',
      'Boolean',
      'Array',
      'Struct',
      'Record',
      'Tuple',
      'Union',
      'Literal',
      'NullOr',
      'Unknown',
      'Null',
      'optional',
      'optionalWith',
      'suspend',
      'compose',
      'filter',
      'pattern',
      'Int',
      'Finite',
      'BigIntFromSelf',
      'Uint8ArrayFromSelf',
      'ValidDateFromSelf',
      'greaterThan',
      'greaterThanOrEqualTo',
      'lessThan',
      'lessThanOrEqualTo',
      'greaterThanOrEqualToBigInt',
      'lessThanOrEqualToBigInt',
      'standardSchemaV1',
      'decodeUnknownEither',
    ];
    const missing = used.filter((k) => !(k in Schema));
    expect(missing, `absent from effect/Schema at ${installed}`).toEqual([]);
  });

  it('ships effect/JSONSchema, so a serialised form is reachable', () => {
    expect(typeof JSONSchema.make).toBe('function');
  });
});

describe('Schema.Number, which is the reason the non-finite handling is inverted here', () => {
  it('accepts NaN and both infinities, unlike z.number() and Type.Number()', () => {
    expect(accepts(Schema.Number, NaN)).toBe(true);
    expect(accepts(Schema.Number, Infinity)).toBe(true);
    expect(accepts(Schema.Number, -Infinity)).toBe(true);
  });

  it('so a column that stores none of them needs Schema.Finite, which refuses all three', () => {
    expect(accepts(Schema.Finite, NaN)).toBe(false);
    expect(accepts(Schema.Finite, Infinity)).toBe(false);
    expect(accepts(Schema.Finite, -Infinity)).toBe(false);
    expect(accepts(Schema.Finite, 1.5)).toBe(true);
  });

  it('and a lower bound alone does not refuse +Infinity, so a bound is not a substitute', () => {
    // `Infinity >= 0` is true. This is why the finite constraint is emitted unconditionally on a
    // column that disallows non-finite values, rather than being left to the range.
    const lowerOnly = Schema.Number.pipe(Schema.greaterThanOrEqualTo(0));
    expect(accepts(lowerOnly, Infinity)).toBe(true);
    expect(accepts(lowerOnly, NaN)).toBe(false);
  });

  it('Schema.Int refuses fractions and both non-finite kinds on its own', () => {
    expect(accepts(Schema.Int, 3)).toBe(true);
    expect(accepts(Schema.Int, 3.5)).toBe(false);
    expect(accepts(Schema.Int, NaN)).toBe(false);
    expect(accepts(Schema.Int, Infinity)).toBe(false);
  });
});

describe('the character-count trap', () => {
  it('Schema.maxLength counts UTF-16 units, so it refuses three astral characters at a cap of 3', () => {
    const three = '\u{1F44D}'.repeat(3);
    expect(three.length, 'UTF-16 units').toBe(6);
    expect(accepts(Schema.String.pipe(Schema.maxLength(3)), three)).toBe(false);
  });

  it('a code-point predicate accepts them, which is what the database does', () => {
    const three = '\u{1F44D}'.repeat(3);
    const cap = Schema.String.pipe(Schema.filter((v: string) => [...v].length <= 3));
    expect(accepts(cap, three)).toBe(true);
    expect(accepts(cap, '\u{1F44D}'.repeat(4))).toBe(false);
  });
});

describe('optional against nullable, which SQL keeps apart', () => {
  it('Schema.optional lets the key go missing and refuses null', () => {
    const s = Schema.Struct({ a: Schema.optional(Schema.String) });
    expect(accepts(s, {})).toBe(true);
    expect(accepts(s, { a: null })).toBe(false);
  });

  it('Schema.NullOr takes null and still demands the key', () => {
    const s = Schema.Struct({ a: Schema.NullOr(Schema.String) });
    expect(accepts(s, { a: null })).toBe(true);
    expect(accepts(s, {})).toBe(false);
  });
});

describe('dates', () => {
  it('Schema.DateFromSelf accepts an Invalid Date and ValidDateFromSelf does not', () => {
    expect(accepts(Schema.DateFromSelf, new Date('nonsense'))).toBe(true);
    expect(accepts(Schema.ValidDateFromSelf, new Date('nonsense'))).toBe(false);
    expect(accepts(Schema.ValidDateFromSelf, new Date(0))).toBe(true);
  });

  it('Schema.Date is a transform from a string, so it refuses the Date a select returns', () => {
    // The reason the generator uses ValidDateFromSelf and states coercion as a union: `Schema.Date`
    // would refuse every row read back out of the database.
    expect(accepts(Schema.Date, new Date(0))).toBe(false);
    expect(accepts(Schema.Date, '2020-01-01')).toBe(true);
  });
});

describe('Schema.standardSchemaV1', () => {
  const T = Schema.Struct({ id: Schema.Number, name: Schema.String });

  it('is needed because a bare Struct carries no ~standard key', () => {
    expect('~standard' in T).toBe(false);
  });

  it('produces a real Standard Schema v1 that validates both ways', () => {
    const std = Schema.standardSchemaV1(T);
    expect(std['~standard'].version).toBe(1);
    expect(std['~standard'].vendor).toBe('effect');
    const good = std['~standard'].validate({ id: 1, name: 'a' }) as { value?: unknown };
    expect(good.value).toEqual({ id: 1, name: 'a' });
    const bad = std['~standard'].validate({ id: 'x', name: 'a' }) as { issues?: unknown[] };
    expect(bad.issues?.length).toBeGreaterThan(0);
  });

  it('returns a new schema and leaves the original alone, which is why both are exported', () => {
    const std = Schema.standardSchemaV1(T);
    expect(std).not.toBe(T);
    expect('~standard' in T, 'the call must not mutate its argument').toBe(false);
  });

  it('drops `.fields`, so the bare form is the only one that composes', () => {
    // `Schema.pick`, `Schema.omit` and spreading into another Struct all go through `fields`.
    // This is the whole reason the generator exports the plain schema as well as the wrapped one.
    const std = Schema.standardSchemaV1(T) as unknown as { fields?: unknown };
    expect(T.fields).toBeDefined();
    expect(std.fields).toBeUndefined();
  });
});

describe('Schema.Unknown, which cannot be made to require its key', () => {
  it('accepts a missing key, because a missing key reads as undefined', () => {
    // Stated as a measurement rather than left implied: a column the analyzer cannot type is
    // optional in practice in every mode, and no arrangement of NullOr or Struct changes that.
    expect(accepts(Schema.Struct({ a: Schema.Unknown }), {})).toBe(true);
    expect(accepts(Schema.Struct({ a: Schema.NullOr(Schema.Unknown) }), {})).toBe(true);
    expect(
      accepts(Schema.Struct({ a: Schema.String }), {}),
      'a typed column still requires it'
    ).toBe(false);
  });
});

describe('a filter placed after Schema.Record sees the rebuilt object, not the input', () => {
  it('so a plain-object guard has to come first', () => {
    const isPlain = (o: unknown) => {
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
      const p = Object.getPrototypeOf(o);
      return p === Object.prototype || p === null;
    };
    const after = Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
      Schema.filter(isPlain)
    );
    expect(accepts(after, new Date()), 'a Date survives the guard placed after').toBe(true);

    const before = Schema.Unknown.pipe(
      Schema.filter(isPlain),
      Schema.compose(Schema.Record({ key: Schema.String, value: Schema.Unknown }), {
        strict: false,
      })
    );
    expect(accepts(before, new Date())).toBe(false);
    expect(accepts(before, { a: 1 })).toBe(true);
  });
});
