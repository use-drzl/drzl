/**
 * Why this generator requires `@ts-rest/core` 3.53.0-rc.1 or newer.
 *
 * The declared floor is rc.1, which is what `package.json` asks for and what these tests run
 * against. The Standard Schema support itself landed one release earlier: rc.0 exports
 * `isStandardSchema`, `validateAgainstStandardSchema` and `parseAsStandardSchema`, and does not
 * export `checkZodSchema` at all. Measured 2026-08-14. The floor is rc.1 rather than rc.0 because
 * that is the version this package pins and tests; nothing here has been run against rc.0.
 *
 * Depending on a release candidate is a real cost, so the reason is pinned here rather than left in
 * a comment. Both halves are must-fire tests: if a later ts-rest fixes either one, these fail and
 * say the floor can move.
 *
 * `@ts-rest/core-stable` is an npm alias for 3.52.1, the `latest` tag as of 2026-08-11.
 */
import { describe, expect, it } from 'vitest';
import * as stable from '@ts-rest/core-stable';
import * as rc from '@ts-rest/core';
import * as v from 'valibot';
import { z } from 'zod';

/** An object that is wrong in two ways: a number where a string belongs, and an unknown key. */
const bad = { email: 12345, wat: true };

describe('the stable ts-rest, which this generator does not target', () => {
  /**
   * The quiet half, and the one that decided the floor.
   *
   * 3.52.1 decides whether a schema is a schema with `typeof obj?.safeParse === 'function'`, and
   * anything failing that test falls through `checkZodSchema` to `{ success: true, data }`. valibot
   * and arktype expose `~standard` but no `.safeParse` method, so a contract built from either
   * validates nothing while looking exactly like one that does.
   */
  it('reports an invalid valibot body as a success, with the unknown key intact', () => {
    const result = stable.checkZodSchema(bad, v.object({ email: v.string() }));
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual(bad);
  });

  it('rejects the same body when the schema is zod, which is the contrast', () => {
    expect(stable.checkZodSchema(bad, z.object({ email: z.string() })).success).toBe(false);
  });

  it('has no Standard Schema entry point at all', () => {
    expect('validateAgainstStandardSchema' in stable).toBe(false);
    expect('parseAsStandardSchema' in stable).toBe(false);
  });
});

describe('the release candidate, which it does target', () => {
  it('validates a valibot schema through ~standard, and rejects the bad body', () => {
    const schema = rc.parseAsStandardSchema(v.object({ email: v.string() }));
    // Null would mean it did not recognise the schema at all, which is 3.52.1's answer above.
    expect(schema).not.toBeNull();
    expect(rc.validateAgainstStandardSchema(bad, schema!).error).toBeDefined();
  });

  it('accepts a valid body through the same path', () => {
    const schema = rc.parseAsStandardSchema(v.object({ email: v.string() }));
    const result = rc.validateAgainstStandardSchema({ email: 'a@b.c' }, schema!);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ email: 'a@b.c' });
  });

  /**
   * The discriminator, which DRZL keeps having to check.
   *
   * A valibot *Standard Schema* failure is `{ value, typed, issues }`: it carries a `value` key
   * alongside its issues, holding the partially-parsed input. So code testing `'value' in result`
   * reports every valibot failure as a success. The specification defines `issues` as the
   * discriminator, and the assertion above only holds because ts-rest uses it.
   *
   * The `value` key belongs to `~standard.validate` and not to `v.safeParse`, whose failure result
   * spells the same field `output`. That distinction is the whole trap: the object an adapter
   * inspects is the first one, so reading the second is what makes the mistake look safe. Both are
   * asserted here rather than described.
   */
  it('is testing issues rather than the presence of value, which valibot failures carry', () => {
    const schema = v.object({ email: v.string() });
    const standard = schema['~standard'].validate(bad);
    // Synchronous, which ts-rest also requires: it throws outright on a Promise.
    expect(standard).not.toBeInstanceOf(Promise);
    const settled = standard as Exclude<typeof standard, Promise<unknown>>;
    expect(settled.issues).toBeDefined();
    expect('value' in settled).toBe(true);

    // The same failure through valibot's own entry point, which names the field differently.
    const direct = v.safeParse(schema, bad);
    expect(direct.success).toBe(false);
    expect('value' in direct).toBe(false);
    expect('output' in direct).toBe(true);
  });
});

describe('the libraries a contract can be built from', () => {
  /**
   * The supported set is exactly the schemas that carry `~standard` on the object itself.
   *
   * TypeBox and Effect Schema do not, which is why `validation.library` rejects them. Asserted
   * against the real packages rather than restated, so the day either one adds it, this fails.
   */
  it('is the three that expose ~standard on the schema object', async () => {
    const { type } = await import('arktype');
    const has = (s: unknown) => !!(s as Record<string, unknown> | null)?.['~standard'];
    expect(has(z.object({ a: z.string() }))).toBe(true);
    expect(has(v.object({ a: v.string() }))).toBe(true);
    expect(has(type({ a: 'string' }))).toBe(true);
  });
});
