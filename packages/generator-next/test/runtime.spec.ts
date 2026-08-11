/**
 * The emitted actions are called with the `FormData` a browser really posts.
 *
 * This is the only test that can see what this generator is for. A form posts strings, a schema
 * describes a row, and the whole value of the package is the conversion between them, which is
 * invisible in the emitted text: whether an empty number box reaches the schema as `NaN` rather
 * than as `0`, whether an unchecked checkbox reaches it as `false` rather than as absent, whether a
 * blank optional box becomes `null` rather than `''`, and above all whether a date input's value
 * parses at all.
 *
 * That last one is the reason the package exists, and it has its own case below. Measured on
 * 2026-08-11: `z.iso.datetime()` and `v.isoTimestamp()` refuse every spelling a browser posts from
 * `<input type="date">` and `<input type="datetime-local">`, so a form wired straight to a
 * generated schema could not submit a date at all.
 *
 * The shared schemas are written by the test rather than by `@drzl/generator-zod`, deliberately:
 * this is a test of *this* package's wiring, and depending on a sibling package's `dist` would
 * make a green run mean "the last build of the zod generator was fine" instead.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { NextGenerator } from '../src';
import { analysis, profile } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');

type Lib = 'zod' | 'valibot' | 'arktype';
type FormState = { status: string; errors: Record<string, string[]> };
type Action = (prev: FormState, data: FormData) => Promise<FormState>;

/** The shared schema module, per library, spelled the way DRZL's own generators spell it. */
const SHARED: Record<Lib, string> = {
  zod: `import { z } from 'zod';
const base = {
  handle: z.string().min(3).max(20),
  bio: z.string().nullable().optional(),
  age: z.number().int().min(18).max(120),
  rating: z.number().nullable().optional(),
  active: z.boolean().optional(),
  bornOn: z.iso.datetime().transform((s) => new Date(s)),
  seenAt: z.iso.datetime().transform((s) => new Date(s)).nullable().optional(),
  status: z.enum(['draft', 'live'] as const),
};
export const InsertprofileSchema = z.object(base);
export const UpdateprofileSchema = z.object(base).partial();
`,
  valibot: `import * as v from 'valibot';
const base = {
  handle: v.pipe(v.string(), v.minLength(3), v.maxLength(20)),
  bio: v.optional(v.nullable(v.string())),
  age: v.pipe(v.number(), v.integer(), v.minValue(18), v.maxValue(120)),
  rating: v.optional(v.nullable(v.number())),
  active: v.optional(v.boolean()),
  bornOn: v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s))),
  seenAt: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s))))),
  status: v.picklist(['draft', 'live'] as const),
};
export const InsertprofileSchema = v.object(base);
export const UpdateprofileSchema = v.partial(v.object(base));
`,
  arktype: `import { type } from 'arktype';
export const InsertprofileSchema = type({
  handle: '3 <= string <= 20',
  'bio?': '(string | null)',
  age: '18 <= number.integer <= 120',
  'rating?': '(number | null)',
  'active?': 'boolean',
  bornOn: 'string.date.iso.parse',
  'seenAt?': "(string.date.iso.parse | null)",
  status: "'draft' | 'live'",
});
export const UpdateprofileSchema = InsertprofileSchema.partial();
`,
};

interface Emitted {
  create: Action;
  update: Action;
  EMPTY: FormState;
}

async function build(lib: Lib): Promise<Emitted> {
  const dir = path.join(pkgRoot, 'test', 'tmp', 'runtime', lib);
  const shared = path.join(dir, 'validators');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'index.ts'), SHARED[lib], 'utf8');

  const out = path.join(dir, 'actions');
  await new NextGenerator(analysis([profile])).generate({
    outputDir: path.relative(process.cwd(), out),
    importExtension: 'none',
    validation: {
      library: lib,
      useShared: true,
      importPath: path.relative(process.cwd(), shared),
    },
  });

  const mod = await import(pathToFileURL(path.join(out, 'profile.ts')).href);
  const helpers = await import(pathToFileURL(path.join(out, 'form-state.ts')).href);
  return {
    create: mod.createProfile as Action,
    update: mod.updateProfile as Action,
    EMPTY: helpers.EMPTY_FORM_STATE as FormState,
  };
}

/**
 * What happened to a submission: the state an action returned, or the marker for having got past
 * the parse into the unwritten handler.
 *
 * The stubs throw `Not implemented`, so reaching one is a *rejection* rather than a return value.
 * Distinguishing the two is the whole assertion in most cases below: a rejected parse comes back
 * as a `FormState`, and a passing one comes back as this marker.
 */
const REACHED_HANDLER = 'reached-handler';

async function outcome(
  action: Action,
  empty: FormState,
  data: FormData
): Promise<FormState | typeof REACHED_HANDLER> {
  try {
    return await action(empty, data);
  } catch (err) {
    if (String(err).includes('Not implemented')) return REACHED_HANDLER;
    throw err;
  }
}

/** What a browser posts for a filled-in, valid form. */
function validForm(over: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields: Record<string, string> = {
    handle: 'omar',
    bio: '',
    age: '30',
    active: 'on',
    // Exactly what `<input type="date">` and `<input type="datetime-local">` submit.
    bornOn: '1995-04-17',
    seenAt: '2026-08-11T14:30',
    status: 'live',
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

describe.each(['zod', 'valibot', 'arktype'] as const)('an emitted action (%s)', (lib) => {
  let e: Emitted;
  beforeAll(async () => {
    e = await build(lib);
  }, 30_000);

  /**
   * The headline. Every value here is refused by the generated schema when handed over as the raw
   * string the browser sent, which is what a hand-written action does. Getting past this assertion
   * is the entire reason `dateField` exists.
   */
  it('accepts the date spellings a browser actually posts', async () => {
    for (const [dateValue, dateTimeValue] of [
      ['1995-04-17', '2026-08-11T14:30'],
      ['1995-04-17', '2026-08-11T14:30:00'],
      ['1995-04-17', '2026-08-11T14:30:00.500'],
      ['1995-04-17', '2026-08-11T14:30:00Z'],
    ]) {
      // Reaching the stub is success: the parse passed and the handler is what is unwritten.
      const got = await outcome(
        e.create,
        e.EMPTY,
        validForm({ bornOn: dateValue, seenAt: dateTimeValue })
      );
      expect(got, `${dateValue} / ${dateTimeValue}`).toBe(REACHED_HANDLER);
    }
  });

  it('still refuses a date that is not one', async () => {
    const state = await e.create(e.EMPTY, validForm({ bornOn: 'yesterday' }));
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors)).toContain('bornOn');
  });

  it('refuses a lone year rather than reading it as 2001', async () => {
    // `new Date('1')` is the year 2001, so a lenient parse turns a typo into a row.
    const state = await e.create(e.EMPTY, validForm({ bornOn: '1' }));
    expect(state.status).toBe('rejected');
  });

  it('reports an empty required box as missing rather than as zero', async () => {
    const state = await e.create(e.EMPTY, validForm({ age: '' }));
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors)).toContain('age');
    // The message must not be about the lower bound: `0` would have been reported as "at least
    // 18", which is a confident answer to a question nobody asked.
    expect(state.errors.age.join(' ')).not.toMatch(/18/);
  });

  it('reads a blank optional box as absence rather than as the empty string', async () => {
    // `bio` has a 0-length-is-fine string type here, so an empty string would parse; what this
    // asserts is that it is not *stored* as one. The nullable reader is the difference.
    expect(await outcome(e.create, e.EMPTY, validForm({ bio: '   ' }))).toBe(REACHED_HANDLER);
  });

  it('reads an unchecked checkbox as false rather than as absent', async () => {
    // An unchecked box is not in FormData at all, which is why presence is the question.
    const data = validForm();
    data.delete('active');
    expect(await outcome(e.create, e.EMPTY, data)).toBe(REACHED_HANDLER);
  });

  it('refuses a value the column constrains, in the constraint vocabulary', async () => {
    const state = await e.create(e.EMPTY, validForm({ age: '7' }));
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors)).toContain('age');
  });

  it('refuses a value outside an enum', async () => {
    const state = await e.create(e.EMPTY, validForm({ status: 'archived' }));
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors)).toContain('status');
  });

  it('keys every message by the input it belongs under', async () => {
    const state = await e.create(e.EMPTY, validForm({ handle: 'x', age: '7' }));
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors).sort()).toEqual(['age', 'handle']);
    for (const messages of Object.values(state.errors)) {
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) expect(typeof m).toBe('string');
    }
  });

  it('sends only the fields an update form posted', async () => {
    // A patch form rendering one box must not blank every other column. The update schema makes
    // every field optional, so an absent one has to stay absent rather than arriving as ''.
    const data = new FormData();
    data.append('id', '1');
    data.append('handle', 'renamed');
    expect(await outcome(e.update, e.EMPTY, data)).toBe(REACHED_HANDLER);
  });

  it('still validates the fields an update form did post', async () => {
    const data = new FormData();
    data.append('id', '1');
    data.append('handle', 'x');
    const state = await e.update(e.EMPTY, data);
    expect(state.status).toBe('rejected');
    expect(Object.keys(state.errors)).toContain('handle');
  });
});

describe('the reader, against what a hand-written action would do', () => {
  /**
   * The must-fire half: the same values, handed over raw.
   *
   * Without this the case above passes for a generator that does nothing at all, because a value
   * the schema already accepted would look identical. This is what makes the date normaliser load
   * bearing rather than decorative.
   */
  it('is what makes a browser date parse at all', async () => {
    const { z } = await import('zod');
    const schema = z.iso.datetime();
    for (const raw of ['1995-04-17', '2026-08-11T14:30', '2026-08-11T14:30:00']) {
      expect(schema.safeParse(raw).success, `${raw} was accepted raw`).toBe(false);
    }

    const dir = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'zod', 'actions');
    const helpers = await import(pathToFileURL(path.join(dir, 'form-state.ts')).href);
    for (const raw of ['1995-04-17', '2026-08-11T14:30', '2026-08-11T14:30:00']) {
      const data = new FormData();
      data.append('d', raw);
      expect(schema.safeParse(helpers.dateField(data, 'd')).success, raw).toBe(true);
    }
  });

  it('leaves a value carrying its own zone alone', async () => {
    const dir = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'zod', 'actions');
    const helpers = await import(pathToFileURL(path.join(dir, 'form-state.ts')).href);
    const data = new FormData();
    data.append('d', '2026-08-11T14:30:00+01:00');
    expect(helpers.dateField(data, 'd')).toBe('2026-08-11T14:30:00+01:00');
  });

  it('reads a bare local time as UTC rather than as the server timezone', async () => {
    // Not the server's zone, deliberately: that makes one submission mean two different instants
    // depending on which region the server happens to run in.
    const dir = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'zod', 'actions');
    const helpers = await import(pathToFileURL(path.join(dir, 'form-state.ts')).href);
    const data = new FormData();
    data.append('d', '2026-08-11T14:30');
    expect(helpers.dateField(data, 'd')).toBe('2026-08-11T14:30:00.000Z');
  });
});
